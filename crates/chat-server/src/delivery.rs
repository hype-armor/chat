//! Durable store-and-forward queue (docs/03-architecture.md §5.1, §5.3).

use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope},
};
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    error::ApiError,
    keys::LEASE_MINUTES,
    limits::{self, DAY, Limits},
};

const MAX_ID_BYTES: usize = 64;
const MAX_CIPHERTEXT_BYTES: usize = 128 * 1024;
/// 50 members × several devices each.
const MAX_RECIPIENTS: usize = 500;
/// Envelopes returned per queue read.
pub const BATCH: i64 = 100;

#[derive(Debug, PartialEq, Eq)]
pub enum SendOutcome {
    /// Stored. `removed`: devices this commit took out of the conversation;
    /// the caller tells their sessions (ADR-0022).
    Accepted { removed: Vec<Uuid> },
    /// Another commit already advanced this group's epoch; the sender must
    /// process it and retry on the new epoch.
    EpochConflict,
}

pub fn parse_recipients(raw: &[Vec<u8>], allow_empty: bool) -> Result<Vec<Uuid>, ApiError> {
    parse_ids(raw, allow_empty, "send to 1 to 500 devices")
}

/// The members a commit leaves in the conversation (M11).
fn parse_members(raw: &[Vec<u8>]) -> Result<Vec<Uuid>, ApiError> {
    parse_ids(raw, false, "members must be 1 to 500 device ids")
}

/// Device ids, sorted and without duplicates. `empty_or_too_many` is the
/// message for a list that is empty or longer than a send may reach.
fn parse_ids(
    raw: &[Vec<u8>],
    allow_empty: bool,
    empty_or_too_many: &'static str,
) -> Result<Vec<Uuid>, ApiError> {
    if raw.len() > MAX_RECIPIENTS || (raw.is_empty() && !allow_empty) {
        return Err(ApiError::BadRequest(empty_or_too_many));
    }
    let mut ids = raw
        .iter()
        .map(|b| {
            Uuid::from_slice(b)
                .map_err(|_| ApiError::BadRequest("device ids must be 16-byte UUIDs"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

fn validate(env: &Envelope) -> Result<ContentType, ApiError> {
    if env.version != PROTOCOL_VERSION {
        return Err(ApiError::BadRequest("unsupported protocol version"));
    }
    if env.message_id.is_empty() || env.message_id.len() > MAX_ID_BYTES {
        return Err(ApiError::BadRequest("message_id must be 1 to 64 bytes"));
    }
    if env.conversation_id.is_empty() || env.conversation_id.len() > MAX_ID_BYTES {
        return Err(ApiError::BadRequest(
            "conversation_id must be 1 to 64 bytes",
        ));
    }
    if env.ciphertext.is_empty() || env.ciphertext.len() > MAX_CIPHERTEXT_BYTES {
        return Err(ApiError::BadRequest("ciphertext must be 1 byte to 128 KiB"));
    }
    match ContentType::try_from(env.content_type) {
        Ok(ContentType::Unspecified) | Err(_) => Err(ApiError::BadRequest("unknown content type")),
        Ok(t) => Ok(t),
    }
}

/// One send request (ADR-0017).
pub struct Send<'a> {
    pub sender: Uuid,
    pub envelope: &'a Envelope,
    pub recipients: &'a [Uuid],
    /// A welcome accepted together with a commit that adds members.
    pub welcome: Option<(&'a Envelope, &'a [Uuid])>,
    /// Raw `members` of a commit: the devices it leaves in the conversation.
    /// Empty means the commit changes no membership.
    pub members: &'a [Vec<u8>],
}

/// Welcomes may only go to devices whose key packages the sender claimed
/// recently, i.e. people it looked up.
const CLAIM_VALID_DAYS: i32 = 7;

/// Stores one queue entry per recipient device, after checking the send is
/// allowed:
/// - a welcome may start a new conversation (the sender becomes its first
///   member) or come from a member, and only reaches devices the sender
///   claimed key packages for; its recipients become members;
/// - every other envelope must come from a member and go to members;
/// - handshake messages are accepted only if they build on the group's
///   current epoch, so every member applies the same sequence of commits;
/// - a commit that carries the members after it replaces the membership
///   rows, so a device it removes loses send and call access at once (M11).
pub async fn send(db: &PgPool, caps: &Limits, req: Send<'_>) -> Result<SendOutcome, ApiError> {
    let env = req.envelope;
    let content_type = validate(env)?;
    if let Some((welcome, _)) = req.welcome
        && (content_type != ContentType::Handshake
            || validate(welcome)? != ContentType::Welcome
            || welcome.conversation_id != env.conversation_id)
    {
        return Err(ApiError::BadRequest(
            "a welcome can only accompany a commit for the same conversation",
        ));
    }
    let welcome_recipients = req.welcome.map_or(&[][..], |(_, r)| r);
    let mut tx = db.begin().await?;

    let all: Vec<Uuid> = req
        .recipients
        .iter()
        .chain(welcome_recipients)
        .copied()
        .collect();
    let mut unique = all.clone();
    unique.sort_unstable();
    unique.dedup();
    // Locking the recipients (in a fixed order, so concurrent sends cannot
    // deadlock) serialises sends to the same device until commit. Their
    // queue_ids then become visible in increasing order, which the
    // connection's queue cursor relies on (`pending`): otherwise a send
    // that took a lower id but committed later would be skipped.
    let locked: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT device_id FROM devices WHERE device_id = ANY($1)
         ORDER BY device_id FOR NO KEY UPDATE",
    )
    .bind(&unique)
    .fetch_all(&mut *tx)
    .await?;
    // Devices removed since the sender last updated its groups are dropped
    // (ADR-0019); a welcome must still reach real devices.
    let existing: std::collections::HashSet<Uuid> = locked.into_iter().map(|(d,)| d).collect();
    if welcome_recipients.iter().any(|d| !existing.contains(d))
        || (content_type == ContentType::Welcome
            && req.recipients.iter().any(|d| !existing.contains(d)))
    {
        return Err(ApiError::BadRequest("unknown recipient device"));
    }
    let recipients: Vec<Uuid> = req
        .recipients
        .iter()
        .filter(|d| existing.contains(d))
        .copied()
        .collect();
    let recipients = recipients.as_slice();

    let conversation = &env.conversation_id;
    let (sender_is_member, conversation_exists): (bool, bool) = sqlx::query_as(
        "SELECT bool_or(device_id = $2) IS TRUE, count(*) > 0
         FROM conversation_members WHERE conversation_id = $1",
    )
    .bind(conversation)
    .bind(req.sender)
    .fetch_one(&mut *tx)
    .await?;

    if content_type == ContentType::Welcome {
        if conversation_exists && !sender_is_member {
            return Err(ApiError::Forbidden("not a member of this conversation"));
        }
        require_claims(&mut tx, req.sender, recipients).await?;
        add_members(&mut tx, conversation, &[req.sender]).await?;
        add_members(&mut tx, conversation, recipients).await?;
    } else {
        if !sender_is_member {
            return Err(ApiError::Forbidden("not a member of this conversation"));
        }
        let (members,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM conversation_members WHERE conversation_id = $1 AND device_id = ANY($2)",
        )
        .bind(conversation)
        .bind(recipients)
        .fetch_one(&mut *tx)
        .await?;
        if members != recipients.len() as i64 {
            return Err(ApiError::Forbidden("recipient is not in this conversation"));
        }
    }

    // The members a commit leaves in the conversation, when the sender states
    // them. Parsed before the epoch moves, so a bad list fails the same way
    // on every epoch.
    let members = if content_type == ContentType::Handshake && !req.members.is_empty() {
        let members = parse_members(req.members)?;
        if !members.contains(&req.sender) {
            return Err(ApiError::BadRequest(
                "the members after a commit must include the sender",
            ));
        }
        // A device the server does not know would fail the insert below.
        let (known,): (i64,) =
            sqlx::query_as("SELECT count(*) FROM devices WHERE device_id = ANY($1)")
                .bind(members.as_slice())
                .fetch_one(&mut *tx)
                .await?;
        if known != members.len() as i64 {
            return Err(ApiError::BadRequest("unknown device in the members list"));
        }
        Some(members)
    } else {
        None
    };

    if content_type == ContentType::Handshake {
        let epoch =
            i64::try_from(env.epoch).map_err(|_| ApiError::BadRequest("epoch out of range"))?;
        let advanced: Option<(i64,)> = sqlx::query_as(
            "INSERT INTO group_epochs (group_id, epoch, last_commit_hash) VALUES ($1, $2 + 1, $3)
             ON CONFLICT (group_id) DO UPDATE
             SET epoch = EXCLUDED.epoch, last_commit_hash = EXCLUDED.last_commit_hash, updated_at = now()
             WHERE group_epochs.epoch = $2
             RETURNING epoch",
        )
        .bind(conversation)
        .bind(epoch)
        .bind(Sha256::digest(&env.ciphertext).to_vec())
        .fetch_optional(&mut *tx)
        .await?;
        if advanced.is_none() {
            return Ok(SendOutcome::EpochConflict);
        }
    }

    // Membership follows the commit, and only after the commit won its epoch:
    // a commit that lost the race changes nothing.
    let mut removed: Vec<Uuid> = Vec::new();
    if let Some(members) = &members {
        removed = replace_members(&mut tx, conversation, members).await?;
    }

    // A device that this commit removed does not get it: it is not a member of
    // the epoch the commit makes, so it cannot read the ciphertext.
    let recipients: Vec<Uuid> = recipients
        .iter()
        .filter(|d| !removed.contains(d))
        .copied()
        .collect();
    let recipients = recipients.as_slice();

    // What this send will store, charged to the sender inside the
    // transaction: a device cannot flood a recipient's queue day after day.
    let kib = envelope_kib(env) + req.welcome.map_or(0, |(w, _)| envelope_kib(w));
    limits::tx_take(
        &mut tx,
        &format!("send-bytes:{}", req.sender),
        kib,
        caps.send_mb_per_day.saturating_mul(1024),
        DAY,
    )
    .await?;

    if let Some((welcome, recipients)) = req.welcome {
        require_claims(&mut tx, req.sender, recipients).await?;
        // The welcome consumes the package the sender leased for each device.
        sqlx::query("DELETE FROM key_packages WHERE claimed_by = $1 AND device_id = ANY($2)")
            .bind(req.sender)
            .bind(recipients)
            .execute(&mut *tx)
            .await?;
        add_members(&mut tx, conversation, recipients).await?;
        enqueue(&mut tx, welcome, recipients).await?;
    }
    enqueue(&mut tx, env, recipients).await?;
    // Hard bound per recipient: the oldest unacked envelopes go first, so a
    // flood costs the sender its budget and the recipient no newest message.
    sqlx::query(
        "DELETE FROM queued_envelopes WHERE queue_id IN (
             SELECT queue_id FROM queued_envelopes
             WHERE recipient_device_id = ANY($1)
             ORDER BY queue_id DESC OFFSET $2)",
    )
    .bind(&unique)
    .bind(caps.queue_rows_per_device.max(1))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(SendOutcome::Accepted { removed })
}

/// Size of an envelope in KiB, at least 1: the rate-limit table counts units.
fn envelope_kib(env: &Envelope) -> i32 {
    i32::try_from(env.encoded_len().div_ceil(1024))
        .unwrap_or(i32::MAX)
        .max(1)
}

type Tx<'a> = sqlx::Transaction<'a, sqlx::Postgres>;

async fn require_claims(tx: &mut Tx<'_>, sender: Uuid, devices: &[Uuid]) -> Result<(), ApiError> {
    let (claimed,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM key_package_claims
         WHERE claimer_device_id = $1 AND claimed_device_id = ANY($2)
           AND claimed_at > now() - make_interval(days => $3)",
    )
    .bind(sender)
    .bind(devices)
    .bind(CLAIM_VALID_DAYS)
    .fetch_one(&mut **tx)
    .await?;
    if claimed != devices.len() as i64 {
        return Err(ApiError::Forbidden(
            "welcomes can only go to devices whose keys you claimed",
        ));
    }
    Ok(())
}

async fn add_members(
    tx: &mut Tx<'_>,
    conversation: &[u8],
    devices: &[Uuid],
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO conversation_members (conversation_id, device_id)
         SELECT $1, d FROM UNNEST($2::uuid[]) AS d ON CONFLICT DO NOTHING",
    )
    .bind(conversation)
    .bind(devices)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Makes `devices` the members of the conversation and returns the devices
/// that were removed, so the caller can tell their sessions.
async fn replace_members(
    tx: &mut Tx<'_>,
    conversation: &[u8],
    devices: &[Uuid],
) -> Result<Vec<Uuid>, ApiError> {
    let removed: Vec<(Uuid,)> = sqlx::query_as(
        "DELETE FROM conversation_members
         WHERE conversation_id = $1 AND NOT device_id = ANY($2)
         RETURNING device_id",
    )
    .bind(conversation)
    .bind(devices)
    .fetch_all(&mut **tx)
    .await?;
    add_members(tx, conversation, devices).await?;
    Ok(removed.into_iter().map(|(device,)| device).collect())
}

async fn enqueue(tx: &mut Tx<'_>, env: &Envelope, recipients: &[Uuid]) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO queued_envelopes (recipient_device_id, message_id, envelope)
         SELECT d, $2, $3 FROM UNNEST($1::uuid[]) AS d
         ON CONFLICT (recipient_device_id, message_id) DO NOTHING",
    )
    .bind(recipients)
    .bind(&env.message_id)
    .bind(env.encode_to_vec())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Queued envelopes for a device after `after` (a queue cursor), oldest first.
/// A queued envelope and how long it has waited, in seconds.
pub struct Pending {
    pub queue_id: i64,
    pub envelope: Envelope,
    pub waited: f64,
}

pub async fn pending(db: &PgPool, device: Uuid, after: i64) -> Result<Vec<Pending>, ApiError> {
    let rows: Vec<(i64, Vec<u8>, f64)> = sqlx::query_as(
        "SELECT queue_id, envelope,
                EXTRACT(EPOCH FROM clock_timestamp() - received_at)::float8
         FROM queued_envelopes
         WHERE recipient_device_id = $1 AND queue_id > $2 ORDER BY queue_id LIMIT $3",
    )
    .bind(device)
    .bind(after)
    .bind(BATCH)
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|(queue_id, bytes, waited)| {
            Ok(Pending {
                queue_id,
                envelope: Envelope::decode(bytes.as_slice())
                    .map_err(|e| ApiError::Internal(e.into()))?,
                waited,
            })
        })
        .collect()
}

pub async fn ack(db: &PgPool, device: Uuid, message_id: &[u8]) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM queued_envelopes WHERE recipient_device_id = $1 AND message_id = $2")
        .bind(device)
        .bind(message_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Deletes expired queue entries, key packages and verification state
/// (FR-MSG-9: 30-day retention).
pub async fn expire(db: &PgPool) -> Result<(), sqlx::Error> {
    // Leases from claims that never became a welcome; a package a welcome did
    // use is deleted in `send`.
    sqlx::query(
        "UPDATE key_packages SET claimed_by = NULL, claimed_at = NULL
         WHERE claimed_at < now() - make_interval(mins => $1)",
    )
    .bind(LEASE_MINUTES)
    .execute(db)
    .await?;
    for stmt in [
        "DELETE FROM queued_envelopes WHERE received_at < now() - interval '30 days'",
        "DELETE FROM key_packages WHERE expires_at < now()",
        "DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'",
        "DELETE FROM link_requests WHERE expires_at < now()",
        "DELETE FROM invites WHERE expires_at < now()",
        "DELETE FROM reports WHERE created_at < now() - interval '90 days'",
    ] {
        sqlx::query(stmt).execute(db).await?;
    }
    Ok(())
}

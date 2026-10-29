//! Durable store-and-forward queue (docs/03-architecture.md §5.1, §5.3).

use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope},
};
use prost::Message;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;

const MAX_ID_BYTES: usize = 64;
const MAX_CIPHERTEXT_BYTES: usize = 128 * 1024;
/// 50 members × several devices each.
const MAX_RECIPIENTS: usize = 500;
/// Envelopes returned per queue read.
pub const BATCH: i64 = 100;

#[derive(Debug, PartialEq, Eq)]
pub enum SendOutcome {
    Accepted,
    /// Another commit already advanced this group's epoch; the sender must
    /// process it and retry on the new epoch.
    EpochConflict,
}

pub fn parse_recipients(raw: &[Vec<u8>]) -> Result<Vec<Uuid>, ApiError> {
    let mut ids = raw
        .iter()
        .map(|b| {
            Uuid::from_slice(b)
                .map_err(|_| ApiError::BadRequest("recipient ids must be 16-byte UUIDs"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() || ids.len() > MAX_RECIPIENTS {
        return Err(ApiError::BadRequest("send to 1 to 500 devices"));
    }
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

/// Stores one queue entry per recipient device. Handshake messages are
/// accepted only if they build on the group's current epoch, so every
/// member applies the same sequence of commits.
pub async fn send(
    db: &PgPool,
    env: &Envelope,
    recipients: &[Uuid],
) -> Result<SendOutcome, ApiError> {
    let content_type = validate(env)?;
    let mut tx = db.begin().await?;

    let (known,): (i64,) = sqlx::query_as("SELECT count(*) FROM devices WHERE device_id = ANY($1)")
        .bind(recipients)
        .fetch_one(&mut *tx)
        .await?;
    if known != recipients.len() as i64 {
        return Err(ApiError::BadRequest("unknown recipient device"));
    }

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
        .bind(&env.conversation_id)
        .bind(epoch)
        .bind(Sha256::digest(&env.ciphertext).to_vec())
        .fetch_optional(&mut *tx)
        .await?;
        if advanced.is_none() {
            return Ok(SendOutcome::EpochConflict);
        }
    }

    sqlx::query(
        "INSERT INTO queued_envelopes (recipient_device_id, message_id, envelope)
         SELECT d, $2, $3 FROM UNNEST($1::uuid[]) AS d
         ON CONFLICT (recipient_device_id, message_id) DO NOTHING",
    )
    .bind(recipients)
    .bind(&env.message_id)
    .bind(env.encode_to_vec())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(SendOutcome::Accepted)
}

/// Queued envelopes for a device after `after` (a queue cursor), oldest first.
pub async fn pending(
    db: &PgPool,
    device: Uuid,
    after: i64,
) -> Result<Vec<(i64, Envelope)>, ApiError> {
    let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT queue_id, envelope FROM queued_envelopes
         WHERE recipient_device_id = $1 AND queue_id > $2 ORDER BY queue_id LIMIT $3",
    )
    .bind(device)
    .bind(after)
    .bind(BATCH)
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|(id, bytes)| {
            Ok((
                id,
                Envelope::decode(bytes.as_slice()).map_err(|e| ApiError::Internal(e.into()))?,
            ))
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
    for stmt in [
        "DELETE FROM queued_envelopes WHERE received_at < now() - interval '30 days'",
        "DELETE FROM key_packages WHERE expires_at < now()",
        "DELETE FROM verification_codes WHERE expires_at < now()",
        "DELETE FROM code_requests WHERE requested_at < now() - interval '1 day'",
    ] {
        sqlx::query(stmt).execute(db).await?;
    }
    Ok(())
}

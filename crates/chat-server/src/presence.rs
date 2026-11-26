//! Experimental database primitives for the gated polling transport.
//! The server sees account relationships, device IDs, ciphertext sizes, and
//! update and poll timing. Each operation validates the bearer token in its transaction.
//! Recipient clients must validate MLS context and the returned generation.

use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

#[derive(Debug)]
pub enum Error {
    Database(sqlx::Error),
    Unauthorized,
    Conflict,
    Invalid,
    Limited,
}
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Self::Database(e)
    }
}

async fn device(tx: &mut Transaction<'_, Postgres>, id: Uuid, token: &str) -> Result<Uuid, Error> {
    sqlx::query_scalar(
        "SELECT account_id FROM devices WHERE device_id = $1 AND auth_token_hash = $2 FOR SHARE",
    )
    .bind(id)
    .bind(crate::auth::token_hash(token))
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::Unauthorized)
}

pub(crate) async fn rate(
    db: &PgPool,
    id: Uuid,
    token: &str,
    action: &str,
    max: i32,
) -> Result<(), Error> {
    let mut tx = db.begin().await?;
    device(&mut tx, id, token).await?;
    let count: i32 = sqlx::query_scalar("INSERT INTO presence_rate_limits (device, action, window_start, count) VALUES ($1,$2,clock_timestamp(),1) ON CONFLICT (device, action) DO UPDATE SET count = CASE WHEN presence_rate_limits.window_start <= clock_timestamp() - interval '1 minute' THEN 1 ELSE LEAST(presence_rate_limits.count, 2147483646) + 1 END, window_start = CASE WHEN presence_rate_limits.window_start <= clock_timestamp() - interval '1 minute' THEN clock_timestamp() ELSE presence_rate_limits.window_start END RETURNING count")
        .bind(id).bind(action).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    if count > max {
        return Err(Error::Limited);
    }
    Ok(())
}

/// Replace one explicit grant, with optimistic account-wide consent version.
/// Every change, including regrant, receives a new generation.
pub async fn set_grant(
    db: &PgPool,
    device_id: Uuid,
    token: &str,
    recipient: Uuid,
    expected: i64,
    enabled: bool,
) -> Result<i64, Error> {
    rate(db, device_id, token, "write", 120).await?;
    if !(0..9_007_199_254_740_991).contains(&expected) {
        return Err(Error::Invalid);
    }
    let mut tx = db.begin().await?;
    let sender = device(&mut tx, device_id, token).await?;
    if sender == recipient {
        return Err(Error::Invalid);
    }
    sqlx::query("INSERT INTO presence_versions (account_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(sender)
        .execute(&mut *tx)
        .await?;
    let version: i64 = sqlx::query_scalar(
        "SELECT version FROM presence_versions WHERE account_id = $1 FOR UPDATE",
    )
    .bind(sender)
    .fetch_one(&mut *tx)
    .await?;
    if version != expected {
        return Err(Error::Conflict);
    }
    let next = version + 1;
    // Delete first so any old leases cannot survive a generation change.
    sqlx::query("DELETE FROM presence_grants WHERE sender=$1 AND recipient=$2")
        .bind(sender)
        .bind(recipient)
        .execute(&mut *tx)
        .await?;
    if enabled {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM presence_grants WHERE sender=$1")
            .bind(sender)
            .fetch_one(&mut *tx)
            .await?;
        if count >= 100 {
            return Err(Error::Limited);
        }
        sqlx::query("INSERT INTO presence_grants (sender,recipient,generation) VALUES ($1,$2,$3)")
            .bind(sender)
            .bind(recipient)
            .bind(next)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE presence_versions SET version=$2 WHERE account_id=$1")
        .bind(sender)
        .bind(next)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(next)
}

/// Read the account-wide version and grants in one database snapshot.
pub async fn consent(
    db: &PgPool,
    device_id: Uuid,
    token: &str,
) -> Result<(i64, Vec<(Uuid, i64)>), Error> {
    rate(db, device_id, token, "poll", 120).await?;
    let mut tx = db.begin().await?;
    let sender = device(&mut tx, device_id, token).await?;
    // A single statement keeps the version and all grants in the same snapshot,
    // including when there is no version row or no grant row.
    let rows: Vec<(i64, Option<Uuid>, Option<i64>)> = sqlx::query_as(
        "SELECT COALESCE(v.version, 0), g.recipient, g.generation \
         FROM (SELECT $1::uuid AS account_id) a \
         LEFT JOIN presence_versions v ON v.account_id = a.account_id \
         LEFT JOIN presence_grants g ON g.sender = a.account_id ORDER BY g.recipient",
    )
    .bind(sender)
    .fetch_all(&mut *tx)
    .await?;
    let version = rows[0].0;
    let grants = rows
        .into_iter()
        .filter_map(|(_, recipient, generation)| recipient.zip(generation))
        .collect();
    tx.commit().await?;
    Ok((version, grants))
}

/// Read the current grant generation for the authenticated recipient.
pub async fn generation(
    db: &PgPool,
    device_id: Uuid,
    token: &str,
    sender: Uuid,
) -> Result<Option<i64>, Error> {
    rate(db, device_id, token, "poll", 120).await?;
    let mut tx = db.begin().await?;
    let recipient = device(&mut tx, device_id, token).await?;
    let generation = sqlx::query_scalar(
        "SELECT generation FROM presence_grants WHERE sender=$1 AND recipient=$2",
    )
    .bind(sender)
    .bind(recipient)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(generation)
}

/// Store an opaque MLS ciphertext for at most 60 seconds.
pub async fn publish(
    db: &PgPool,
    device_id: Uuid,
    token: &str,
    recipient: Uuid,
    generation: i64,
    ciphertext: &[u8],
) -> Result<(), Error> {
    rate(db, device_id, token, "write", 120).await?;
    if ciphertext.is_empty() || ciphertext.len() > 8192 || generation <= 0 {
        return Err(Error::Invalid);
    }
    let mut tx = db.begin().await?;
    let sender = device(&mut tx, device_id, token).await?;
    // Serialize publishers for this grant to enforce the lease bound.
    let valid: Option<i64> = sqlx::query_scalar(
        "SELECT generation FROM presence_grants WHERE sender=$1 AND recipient=$2 FOR UPDATE",
    )
    .bind(sender)
    .bind(recipient)
    .fetch_optional(&mut *tx)
    .await?;
    if valid != Some(generation) {
        return Err(Error::Unauthorized);
    }
    sqlx::query("DELETE FROM presence_leases WHERE sender=$1 AND recipient=$2 AND expires_at <= clock_timestamp()")
        .bind(sender).bind(recipient).execute(&mut *tx).await?;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM presence_leases WHERE sender=$1 AND recipient=$2 AND device <> $3",
    )
    .bind(sender)
    .bind(recipient)
    .bind(device_id)
    .fetch_one(&mut *tx)
    .await?;
    if count >= 10 {
        return Err(Error::Limited);
    }
    sqlx::query("INSERT INTO presence_leases (sender,recipient,device,generation,ciphertext,expires_at) VALUES ($1,$2,$3,$4,$5,clock_timestamp()+interval '60 seconds') ON CONFLICT (sender,recipient,device) DO UPDATE SET generation=EXCLUDED.generation,ciphertext=EXCLUDED.ciphertext,expires_at=EXCLUDED.expires_at")
        .bind(sender).bind(recipient).bind(device_id).bind(generation).bind(ciphertext).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Delete expired ciphertext. A future transport must schedule this frequently.
pub async fn purge_expired(db: &PgPool) -> Result<u64, Error> {
    Ok(
        sqlx::query("DELETE FROM presence_leases WHERE expires_at <= clock_timestamp()")
            .execute(db)
            .await?
            .rows_affected(),
    )
}

/// The grant lock is the authorization point. A poll that obtains it before
/// revocation can return afterward; later polls return no presence.
pub async fn poll(
    db: &PgPool,
    device_id: Uuid,
    token: &str,
    sender: Uuid,
) -> Result<Vec<(Uuid, i64, Vec<u8>)>, Error> {
    rate(db, device_id, token, "poll", 120).await?;
    let mut tx = db.begin().await?;
    let recipient = device(&mut tx, device_id, token).await?;
    let generation: Option<i64> = sqlx::query_scalar(
        "SELECT generation FROM presence_grants WHERE sender=$1 AND recipient=$2 FOR SHARE",
    )
    .bind(sender)
    .bind(recipient)
    .fetch_optional(&mut *tx)
    .await?;
    let rows = if let Some(generation) = generation {
        sqlx::query_as("SELECT device,generation,ciphertext FROM presence_leases WHERE sender=$1 AND recipient=$2 AND generation=$3 AND expires_at > clock_timestamp() ORDER BY device LIMIT 100")
            .bind(sender).bind(recipient).bind(generation).fetch_all(&mut *tx).await?
    } else {
        Vec::new()
    };
    tx.commit().await?;
    Ok(rows)
}

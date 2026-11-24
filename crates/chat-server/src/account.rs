//! Account deletion (FR-ID-9): removes everything the server holds for an
//! account. Devices, tokens, queued envelopes, key packages, memberships,
//! links, unused invites, reports about it and its backup go (the backup's
//! object explicitly, the rest by cascade); its username
//! becomes free. Rate-limit windows naming its devices expire within two
//! days.

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, db, normalize_username},
    error::{ApiError, ApiJson},
    limits,
};

/// Authoritative account identity for the authenticated device. Never use a
/// cached profile as proof of the current username.
#[derive(Serialize)]
pub struct CurrentAccount {
    account_id: Uuid,
    username: String,
}

pub async fn current(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
) -> Result<(HeaderMap, Json<CurrentAccount>), ApiError> {
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT a.account_id, a.username FROM accounts a
         JOIN devices d USING (account_id) WHERE d.device_id = $1",
    )
    .bind(device)
    .fetch_optional(db(&state)?)
    .await?;
    let (account_id, username) = row.ok_or(ApiError::Unauthorized("invalid token"))?;
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((
        headers,
        Json(CurrentAccount {
            account_id,
            username,
        }),
    ))
}

#[derive(Deserialize)]
pub struct Rename {
    username: String,
    request_id: Uuid,
}

/// The request ID is account-scoped and must never be reused for another name.
pub async fn rename(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    ApiJson(req): ApiJson<Rename>,
) -> Result<Json<CurrentAccount>, ApiError> {
    // Count attempts separately from the rename transaction, so collisions
    // cannot roll back the abuse limit. Successful retries still have their
    // own larger budget and do not consume the five-change daily budget.
    limits::take(
        db(&state)?,
        &format!("rename-attempt:{device}"),
        1,
        60,
        limits::HOUR,
    )
    .await?;
    let username = normalize_username(&req.username).ok_or(ApiError::BadRequest(
        "username must look like name.42: 3-20 letters, digits or _, a dot and 2-4 digits",
    ))?;
    let mut tx = db(&state)?.begin().await?;
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT a.account_id, a.username FROM accounts a JOIN devices d USING (account_id)
         WHERE d.device_id = $1 FOR UPDATE OF a",
    )
    .bind(device)
    .fetch_optional(&mut *tx)
    .await?;
    let (account_id, current) = row.ok_or(ApiError::Unauthorized("invalid token"))?;
    // Revalidate after the account lock: revocation can commit while this
    // request waits and the original join can still reflect an old snapshot.
    lock_deletion_device(&mut tx, account_id, device).await?;
    let prior: Option<(String,)> = sqlx::query_as(
        "SELECT username FROM username_changes WHERE account_id = $1 AND request_id = $2",
    )
    .bind(account_id)
    .bind(req.request_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((prior_name,)) = prior {
        if prior_name != username {
            return Err(ApiError::Conflict("request ID already used"));
        }
        // Return the current name, not a stale result from an earlier change.
        return Ok(Json(CurrentAccount {
            account_id,
            username: current,
        }));
    }
    limits::tx_take(
        &mut tx,
        &format!("rename-account:{account_id}"),
        1,
        5,
        limits::DAY,
    )
    .await?;
    if current != username {
        let reserved: Option<(String,)> = sqlx::query_as(
            "INSERT INTO username_reservations (username, account_id) VALUES ($1, $2)
             ON CONFLICT (username) DO NOTHING RETURNING username",
        )
        .bind(&username)
        .bind(account_id)
        .fetch_optional(&mut *tx)
        .await?;
        reserved.ok_or(ApiError::Conflict("that username is taken"))?;
        sqlx::query("UPDATE username_reservations SET retired = TRUE WHERE username = $1 AND account_id = $2")
            .bind(&current).bind(account_id).execute(&mut *tx).await?;
        sqlx::query("UPDATE accounts SET username = $1 WHERE account_id = $2")
            .bind(&username)
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "INSERT INTO username_changes (account_id, request_id, username) VALUES ($1, $2, $3)",
    )
    .bind(account_id)
    .bind(req.request_id)
    .bind(&username)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(CurrentAccount {
        account_id,
        username,
    }))
}

#[derive(Deserialize)]
pub struct PrepareDeletion {
    username: String,
    authorization: String,
}

fn authorization_hash(secret: &str) -> Result<Vec<u8>, ApiError> {
    if secret.len() != 64
        || !secret
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err(ApiError::BadRequest("invalid deletion authorization"));
    }
    Ok(Sha256::digest(secret.as_bytes()).to_vec())
}

// Lock the account before the device. Device removal locks only the device;
// it must not wait for the account while it holds that lock. Re-read the
// device after the account lock because the join can see a stale snapshot.
async fn lock_deletion_device(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account: Uuid,
    device: Uuid,
) -> Result<(), ApiError> {
    let found: Option<(Uuid,)> = sqlx::query_as(
        "SELECT device_id FROM devices WHERE account_id = $1 AND device_id = $2 FOR UPDATE",
    )
    .bind(account)
    .bind(device)
    .fetch_optional(&mut **tx)
    .await?;
    found.ok_or(ApiError::Unauthorized("invalid token"))?;
    Ok(())
}

/// A retry of the same authorization succeeds even if the account was renamed.
pub async fn prepare_deletion(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    ApiJson(req): ApiJson<PrepareDeletion>,
) -> Result<StatusCode, ApiError> {
    let hash = authorization_hash(&req.authorization)?;
    let mut tx = db(&state)?.begin().await?;
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT a.account_id, a.username FROM accounts a JOIN devices d USING (account_id)
         WHERE d.device_id = $1 FOR UPDATE OF a",
    )
    .bind(device)
    .fetch_optional(&mut *tx)
    .await?;
    let (account, username) = row.ok_or(ApiError::Unauthorized("invalid token"))?;
    lock_deletion_device(&mut tx, account, device).await?;
    // Lock first, then read the clock in a separate statement. A lock wait
    // must not extend the authorization lifetime.
    let prior: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM account_deletion_authorizations
         WHERE account_id = $1 AND device_id = $2 AND secret_hash = $3 FOR UPDATE",
    )
    .bind(account)
    .bind(device)
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?;
    if prior.is_some() {
        let (valid,): (bool,) = sqlx::query_as(
            "SELECT expires_at > clock_timestamp() FROM account_deletion_authorizations
             WHERE account_id = $1 AND device_id = $2 AND secret_hash = $3",
        )
        .bind(account)
        .bind(device)
        .bind(&hash)
        .fetch_one(&mut *tx)
        .await?;
        if !valid {
            return Err(ApiError::Conflict(
                "deletion authorization expired; confirm the current username again",
            ));
        }
        return Ok(StatusCode::NO_CONTENT);
    }
    if req.username.trim().to_ascii_lowercase() != username {
        return Err(ApiError::BadRequest("that is not this account's username"));
    }
    limits::tx_take(
        &mut tx,
        &format!("deletion-prepare:{account}"),
        1,
        10,
        limits::DAY,
    )
    .await?;
    sqlx::query("INSERT INTO account_deletion_authorizations (account_id, device_id, secret_hash) VALUES ($1, $2, $3)")
        .bind(account).bind(device).bind(hash).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Delete {
    /// Old clients can still confirm by username, without race protection.
    username: Option<String>,
    authorization: Option<String>,
}

pub async fn delete(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    ApiJson(req): ApiJson<Delete>,
) -> Result<StatusCode, ApiError> {
    let mut tx = db(&state)?.begin().await?;
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT a.account_id, a.username FROM accounts a
         JOIN devices d USING (account_id) WHERE d.device_id = $1 FOR UPDATE OF a",
    )
    .bind(device)
    .fetch_optional(&mut *tx)
    .await?;
    let (account, username) = row.ok_or(ApiError::Unauthorized("invalid token"))?;
    lock_deletion_device(&mut tx, account, device).await?;
    if let Some(secret) = req.authorization {
        let hash = authorization_hash(&secret)?;
        let authorization: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM account_deletion_authorizations WHERE account_id = $1 AND device_id = $2
             AND secret_hash = $3 FOR UPDATE",
        )
        .bind(account)
        .bind(device)
        .bind(&hash)
        .fetch_optional(&mut *tx)
        .await?;
        let valid = if authorization.is_some() {
            let (valid,): (bool,) = sqlx::query_as(
                "SELECT expires_at > clock_timestamp() FROM account_deletion_authorizations
                 WHERE account_id = $1 AND device_id = $2 AND secret_hash = $3",
            )
            .bind(account)
            .bind(device)
            .bind(&hash)
            .fetch_one(&mut *tx)
            .await?;
            valid
        } else {
            false
        };
        if !valid {
            return Err(ApiError::Conflict(
                "deletion authorization invalid or expired; confirm the current username again",
            ));
        }
    } else if req
        .username
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        != username
    {
        return Err(ApiError::BadRequest("that is not this account's username"));
    }
    let devices: Vec<(Uuid,)> =
        sqlx::query_as("SELECT device_id FROM devices WHERE account_id = $1")
            .bind(account)
            .fetch_all(&mut *tx)
            .await?;
    let watchers = crate::devices::watchers(&mut tx, account).await?;
    let backup: Option<(Option<String>,)> =
        sqlx::query_as("SELECT object_key FROM backups WHERE account_id = $1")
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?;
    sqlx::query(
        "DELETE FROM username_reservations WHERE username = $1 AND account_id = $2 AND NOT retired",
    )
    .bind(&username)
    .bind(account)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM accounts WHERE account_id = $1")
        .bind(account)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // The backup row went by cascade; its object goes here.
    if let Some(store) = &state.blobs {
        crate::backup::forget_counted(store, db(&state)?, backup.and_then(|(k,)| k)).await;
    }
    for (device,) in devices {
        state.hub.disconnect(&device);
    }
    state.hub.devices_changed(&watchers);
    tracing::info!("account deleted");
    Ok(StatusCode::NO_CONTENT)
}

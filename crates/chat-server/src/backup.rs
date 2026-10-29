//! Encrypted backups and restore (ADR-0022). The server stores the latest
//! backup blob per account and SHA-256 of an auth secret derived from the
//! user's recovery key; it can read neither. Restoring proves the auth
//! secret and replaces the account's devices with a new one.

use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, Registered, create_device, db, normalize_username, parse_identity_key},
    devices,
    error::ApiError,
    limits::{self, ClientIp},
};

/// While backups live in PostgreSQL (Phase 2 item 9 moves them).
pub const MAX_BACKUP_BYTES: usize = 25 * 1024 * 1024;

fn secret(raw: &str) -> Result<Vec<u8>, ApiError> {
    STANDARD
        .decode(raw)
        .ok()
        .filter(|b| b.len() == 32)
        .ok_or(ApiError::BadRequest("expected 32 bytes, base64"))
}

async fn account_of(db: &sqlx::PgPool, device: Uuid) -> Result<Uuid, ApiError> {
    let (account,): (Uuid,) = sqlx::query_as("SELECT account_id FROM devices WHERE device_id = $1")
        .bind(device)
        .fetch_one(db)
        .await?;
    Ok(account)
}

#[derive(Deserialize)]
pub struct SetKey {
    /// SHA-256 of the auth secret, base64.
    auth_hash: String,
}

/// `PUT /v1/backup/key`: turns backups on, or switches to a new recovery
/// key; any backup made under the old key is deleted.
pub async fn set_key(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<SetKey>,
) -> Result<StatusCode, ApiError> {
    let db = db(&state)?;
    let account = account_of(db, device).await?;
    sqlx::query(
        "INSERT INTO backups (account_id, auth_hash) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET auth_hash = $2, blob = NULL, updated_at = now()",
    )
    .bind(account)
    .bind(secret(&req.auth_hash)?)
    .execute(db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /v1/backup`: replaces the account's backup (encrypted bytes).
pub async fn upload(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    if body.is_empty() || body.len() > MAX_BACKUP_BYTES {
        return Err(ApiError::BadRequest("a backup is 1 byte to 25 MB"));
    }
    let db = db(&state)?;
    let account = account_of(db, device).await?;
    let updated =
        sqlx::query("UPDATE backups SET blob = $2, updated_at = now() WHERE account_id = $1")
            .bind(account)
            .bind(body.as_ref())
            .execute(db)
            .await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::Conflict("set up a recovery key first"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /v1/backup`: this account's backup, for a restored device.
pub async fn download(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
) -> Result<impl IntoResponse, ApiError> {
    let db = db(&state)?;
    let account = account_of(db, device).await?;
    let row: Option<(Option<Vec<u8>>,)> =
        sqlx::query_as("SELECT blob FROM backups WHERE account_id = $1")
            .bind(account)
            .fetch_optional(db)
            .await?;
    let blob = row
        .and_then(|(b,)| b)
        .ok_or(ApiError::NotFound("no backup"))?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], blob))
}

/// `POST /v1/backup/delete`: turns backups off.
pub async fn delete(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
) -> Result<StatusCode, ApiError> {
    let db = db(&state)?;
    let account = account_of(db, device).await?;
    sqlx::query("DELETE FROM backups WHERE account_id = $1")
        .bind(account)
        .execute(db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Restore {
    username: String,
    /// The auth secret derived from the recovery key, base64.
    auth: String,
    /// Base64 identity public key of the new device.
    identity_key: String,
}

/// `POST /v1/backup/restore`: proves the recovery key and registers this
/// device as the account's only one; members re-add it (ADR-0022).
pub async fn restore(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(req): Json<Restore>,
) -> Result<Json<Registered>, ApiError> {
    let db = db(&state)?;
    let caps = &state.limits;
    if let Some(ip) = ip {
        let key = format!("restore-ip:{ip}");
        limits::take(db, &key, 1, caps.restores_per_ip_per_hour, limits::HOUR).await?;
    }
    let refused = ApiError::Unauthorized("wrong username or recovery key");
    let username = normalize_username(&req.username)
        .ok_or(ApiError::Unauthorized("wrong username or recovery key"))?;
    let identity_key = parse_identity_key(&req.identity_key)?;
    let auth_hash = Sha256::digest(secret(&req.auth)?).to_vec();

    let mut tx = db.begin().await?;
    let row: Option<(Uuid, Vec<u8>)> = sqlx::query_as(
        "SELECT a.account_id, b.auth_hash FROM accounts a JOIN backups b USING (account_id)
         WHERE a.username = $1 FOR UPDATE OF a",
    )
    .bind(&username)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((account, expected)) = row else {
        return Err(refused);
    };
    let key = format!("restore-account:{account}");
    limits::take(db, &key, 1, caps.restores_per_account_per_day, limits::DAY).await?;
    if expected != auth_hash {
        return Err(refused);
    }
    // Who to tell, worked out before the old devices (and their
    // memberships) go.
    let watchers = devices::watchers(&mut tx, account).await?;
    let old: Vec<(Uuid,)> =
        sqlx::query_as("DELETE FROM devices WHERE account_id = $1 RETURNING device_id")
            .bind(account)
            .fetch_all(&mut *tx)
            .await?;
    let registered = create_device(&mut tx, account, username, identity_key).await?;
    tx.commit().await?;
    for (device,) in old {
        state.hub.disconnect(&device);
    }
    state.hub.devices_changed(&watchers);
    tracing::info!("account restored from backup");
    Ok(Json(registered))
}

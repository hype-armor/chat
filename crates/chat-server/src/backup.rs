//! Encrypted backups and restore (ADR-0022). The server stores the latest
//! backup blob per account and SHA-256 of an auth secret derived from the
//! user's recovery key; it can read neither. Restoring proves the auth
//! secret and replaces the account's devices with a new one. Backups live
//! in the blob store (`backups/{account}/{id}`); each upload is a new
//! object, and the old one goes once the row points at the new one.

use std::sync::Arc;

use axum::{
    Json,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::TryStreamExt;
use object_store::{ObjectStore, ObjectStoreExt, PutPayload, path::Path};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, Registered, create_device, db, normalize_username, parse_identity_key},
    blobs, devices,
    error::ApiError,
    limits::{self, ClientIp},
};

/// History plus photo thumbnails; the same cap as an attachment.
pub const MAX_BACKUP_BYTES: u64 = 100 * 1024 * 1024;

fn new_object(account: Uuid) -> String {
    format!("backups/{account}/{}", Uuid::new_v4())
}

/// Deletes a replaced or abandoned backup object; one already gone is fine.
pub async fn forget(store: &Arc<dyn ObjectStore>, key: Option<String>) {
    if let Some(key) = key {
        match store.delete(&Path::from(key)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
            Err(e) => tracing::warn!(error = %e, "deleting an old backup failed"),
        }
    }
}

/// Copies backups made before they moved to the blob store (migration
/// 0010) out of PostgreSQL. Run at startup; does nothing once done.
pub async fn move_to_store(db: &sqlx::PgPool, store: &Arc<dyn ObjectStore>) -> anyhow::Result<()> {
    let old: Vec<(Uuid, Vec<u8>)> =
        sqlx::query_as("SELECT account_id, blob FROM backups WHERE blob IS NOT NULL")
            .fetch_all(db)
            .await?;
    for (account, blob) in old {
        let key = new_object(account);
        let size = blob.len() as i64;
        store
            .put(&Path::from(key.clone()), PutPayload::from(blob))
            .await?;
        sqlx::query(
            "UPDATE backups SET object_key = $2, size_bytes = $3, blob = NULL WHERE account_id = $1",
        )
        .bind(account)
        .bind(&key)
        .bind(size)
        .execute(db)
        .await?;
    }
    Ok(())
}

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
    let store = blobs::store(&state)?;
    let account = account_of(db, device).await?;
    let auth_hash = secret(&req.auth_hash)?;
    let mut tx = db.begin().await?;
    let old: Option<(Option<String>,)> =
        sqlx::query_as("SELECT object_key FROM backups WHERE account_id = $1 FOR UPDATE")
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?;
    sqlx::query(
        "INSERT INTO backups (account_id, auth_hash) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE
         SET auth_hash = $2, blob = NULL, object_key = NULL, size_bytes = NULL, updated_at = now()",
    )
    .bind(account)
    .bind(auth_hash)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    forget(store, old.and_then(|(k,)| k)).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /v1/backup`: replaces the account's backup (encrypted bytes,
/// `Content-Length` required), streamed into the blob store.
pub async fn upload(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    headers: HeaderMap,
    body: Body,
) -> Result<StatusCode, ApiError> {
    let declared: u64 = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or(ApiError::BadRequest("Content-Length is required"))?;
    if declared == 0 || declared > MAX_BACKUP_BYTES {
        return Err(ApiError::BadRequest("a backup is 1 byte to 100 MB"));
    }
    let db = db(&state)?;
    let store = blobs::store(&state)?;
    let account = account_of(db, device).await?;
    let has_key: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM backups WHERE account_id = $1")
        .bind(account)
        .fetch_optional(db)
        .await?;
    if has_key.is_none() {
        return Err(ApiError::Conflict("set up a recovery key first"));
    }
    let key = new_object(account);
    let size = blobs::stream_to(store, &Path::from(key.clone()), declared, body).await?;
    // Point the row at the new object, then drop the one it replaced.
    let mut tx = db.begin().await?;
    let old: Option<(Option<String>,)> =
        sqlx::query_as("SELECT object_key FROM backups WHERE account_id = $1 FOR UPDATE")
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((old,)) = old else {
        // Backups were turned off while this one uploaded.
        tx.rollback().await?;
        forget(store, Some(key)).await;
        return Err(ApiError::Conflict("set up a recovery key first"));
    };
    sqlx::query(
        "UPDATE backups SET object_key = $2, size_bytes = $3, blob = NULL, updated_at = now()
         WHERE account_id = $1",
    )
    .bind(account)
    .bind(&key)
    .bind(size as i64)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    forget(store, old).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /v1/backup`: this account's backup, for a restored device.
pub async fn download(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
) -> Result<impl IntoResponse, ApiError> {
    let db = db(&state)?;
    let store = blobs::store(&state)?;
    let account = account_of(db, device).await?;
    let row: Option<(Option<String>, Option<i64>)> =
        sqlx::query_as("SELECT object_key, size_bytes FROM backups WHERE account_id = $1")
            .bind(account)
            .fetch_optional(db)
            .await?;
    let Some((Some(key), Some(size))) = row else {
        return Err(ApiError::NotFound("no backup"));
    };
    let object = store
        .get(&Path::from(key))
        .await
        .map_err(|_| ApiError::NotFound("no backup"))?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CONTENT_LENGTH, size.to_string()),
        ],
        Body::from_stream(object.into_stream().map_err(std::io::Error::other)),
    ))
}

/// `POST /v1/backup/delete`: turns backups off.
pub async fn delete(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
) -> Result<StatusCode, ApiError> {
    let db = db(&state)?;
    let store = blobs::store(&state)?;
    let account = account_of(db, device).await?;
    let old: Option<(Option<String>,)> =
        sqlx::query_as("DELETE FROM backups WHERE account_id = $1 RETURNING object_key")
            .bind(account)
            .fetch_optional(db)
            .await?;
    forget(store, old.and_then(|(k,)| k)).await;
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

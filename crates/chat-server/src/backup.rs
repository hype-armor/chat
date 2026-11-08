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
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, Registered, create_device, db, normalize_username, parse_identity_key},
    blobs, devices,
    error::{ApiError, ApiJson},
    limits::{self, ClientIp},
    storage,
};

/// History plus photo thumbnails; the same cap as an attachment.
pub const MAX_BACKUP_BYTES: u64 = 100 * 1024 * 1024;
/// Twice the client's 10-minute schedule, including failed upload requests.
const BACKUP_UPLOADS_PER_DAY: i32 = 288;

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

/// Deletes a finished backup object and releases its ledger charge only on
/// confirmed deletion. A failure leaves an orphan charge for operator repair.
pub async fn forget_counted(store: &Arc<dyn ObjectStore>, db: &sqlx::PgPool, key: Option<String>) {
    if let Some(key) = key
        && let Err(e) = storage::forget(store, db, &key).await
    {
        tracing::warn!(error = ?e, "deleting an old backup failed; storage remains charged");
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
        // Migration 0014 reserves this deterministic key, including legacy
        // backups that still live in PostgreSQL. Startup copies reuse it.
        let key = format!("backups/{account}/legacy");
        let size = blob.len() as i64;
        let (reserved,): (bool,) =
            sqlx::query_as("SELECT EXISTS(SELECT 1 FROM storage_objects WHERE object_key = $1)")
                .bind(&key)
                .fetch_one(db)
                .await?;
        if !reserved {
            storage::reserve(db, account, &[(key.clone(), size)])
                .await
                .map_err(|e| anyhow::anyhow!("{}", e.message()))?;
        }
        // A durable claim prevents multiple startup processes from writing
        // this same key. A crashed claim needs operator repair.
        let claimed = sqlx::query(
            "UPDATE storage_objects SET state = 'writing'
             WHERE object_key = $1 AND state = 'reserved'",
        )
        .bind(&key)
        .execute(db)
        .await?;
        if claimed.rows_affected() != 1 {
            let (state,): (String,) =
                sqlx::query_as("SELECT state FROM storage_objects WHERE object_key = $1")
                    .bind(&key)
                    .fetch_one(db)
                    .await?;
            if state == "live" {
                continue;
            }
            anyhow::bail!(
                "legacy backup migration has an unfinished writer; operator repair is required"
            );
        }
        store
            .put(&Path::from(key.clone()), PutPayload::from(blob.clone()))
            .await?;
        let mut tx = db.begin().await?;
        let updated = sqlx::query(
            "UPDATE backups SET object_key = $2, size_bytes = $3, blob = NULL
             WHERE account_id = $1 AND blob = $4 AND object_key IS NULL",
        )
        .bind(account)
        .bind(&key)
        .bind(size)
        .bind(blob)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() == 1 {
            sqlx::query("UPDATE storage_objects SET state = 'live' WHERE object_key = $1")
                .bind(&key)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
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
    ApiJson(req): ApiJson<SetKey>,
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
    forget_counted(store, db, old.and_then(|(k,)| k)).await;
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
    // Charge attempts before quota reservation or object-store work. Even
    // safely aborted requests consume these durable anti-abuse budgets.
    limits::take(
        db,
        &format!("backup-uploads:{account}"),
        1,
        BACKUP_UPLOADS_PER_DAY,
        limits::DAY,
    )
    .await?;
    limits::take(
        db,
        &format!("backup-mb:{account}"),
        declared.div_ceil(1024 * 1024) as i32,
        state.limits.blob_mb_per_day,
        limits::DAY,
    )
    .await?;
    let has_key: Option<(Vec<u8>,)> =
        sqlx::query_as("SELECT auth_hash FROM backups WHERE account_id = $1")
            .bind(account)
            .fetch_optional(db)
            .await?;
    let Some((upload_auth_hash,)) = has_key else {
        return Err(ApiError::Conflict("set up a recovery key first"));
    };
    let key = new_object(account);
    // The old backup remains charged until its physical object is deleted.
    storage::reserve(db, account, &[(key.clone(), declared as i64)]).await?;
    let size = blobs::stream_to(db, store, &Path::from(key.clone()), declared, body).await?;
    storage::mark_ready(db, &key).await?;
    // Point the row at the new object, then drop the one it replaced.
    let mut tx = db.begin().await?;
    let old: Option<(Option<String>, Vec<u8>)> = sqlx::query_as(
        "SELECT object_key, auth_hash FROM backups WHERE account_id = $1 FOR UPDATE",
    )
    .bind(account)
    .fetch_optional(&mut *tx)
    .await?;
    let old = match old {
        Some((old, auth_hash)) if auth_hash == upload_auth_hash => old,
        _ => {
            // The write has finished, so deleting this unused object is safe.
            tx.rollback().await?;
            forget_counted(store, db, Some(key)).await;
            return Err(ApiError::Conflict("recovery key changed during upload"));
        }
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
    sqlx::query("UPDATE storage_objects SET state = 'live' WHERE object_key = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    forget_counted(store, db, old).await;
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
    forget_counted(store, db, old.and_then(|(k,)| k)).await;
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
    ApiJson(req): ApiJson<Restore>,
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
    // The per-IP limit above bounds one attacker. The per-account counters are
    // charged only after the secret is known to be right (or wrong): charging
    // them first would let a stranger lock the real owner out of recovery.
    if !bool::from(expected.as_slice().ct_eq(auth_hash.as_slice())) {
        limits::tx_take(
            &mut tx,
            &format!("restore-fail:{account}"),
            1,
            caps.restore_failures_per_day,
            limits::DAY,
        )
        .await?;
        return Err(refused);
    }
    limits::tx_take(
        &mut tx,
        &format!("restore-account:{account}"),
        1,
        caps.restores_per_account_per_day,
        limits::DAY,
    )
    .await?;
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

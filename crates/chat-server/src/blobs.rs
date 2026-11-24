//! Encrypted attachments (FR-MED-2/3, ADR-0023). Clients encrypt before
//! upload; the server only stores ciphertext, streams it through to an
//! object store (S3-compatible in production) and deletes it after 30 days.
//! Large files go up in parts that can be resumed, and come back by byte
//! range (ADR-0025).

use std::sync::Arc;

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path as UrlPath, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::{StreamExt, TryStreamExt, stream};
use object_store::{
    GetOptions, ObjectStore, ObjectStoreExt, PutPayload, WriteMultipart, path::Path,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, db},
    error::{ApiError, ApiJson},
    limits, storage,
};

/// 100 MB of content plus room for encryption overhead (FR-MED-3).
pub const MAX_BLOB_BYTES: u64 = 100 * 1024 * 1024 + 1024 * 1024;
const BLOB_TTL_DAYS: i32 = 30;
/// Multipart chunk size; S3 needs at least 5 MB per part.
const PART_BYTES: usize = 8 * 1024 * 1024;
/// Parts of a resumable upload; all but the last are exactly this size.
pub const UPLOAD_PART_BYTES: u64 = 8 * 1024 * 1024;
const UPLOAD_TTL_HOURS: i32 = 24;
const COMPLETION_CLAIM_TTL_SECS: i32 = 15 * 60;
const HASH_RANGE_BYTES: u64 = 1024 * 1024;

/// Opens the store named by `CHAT_BLOB_STORE`: `memory` (development),
/// `file:///path`, or `s3://bucket` with the usual `AWS_*` variables
/// (`AWS_ENDPOINT` for SeaweedFS or another S3-compatible store).
pub fn open_store(url: &str) -> anyhow::Result<Arc<dyn ObjectStore>> {
    Ok(match url {
        "memory" => Arc::new(object_store::memory::InMemory::new()),
        _ if url.starts_with("file://") => {
            let dir = &url["file://".len()..];
            std::fs::create_dir_all(dir)?;
            Arc::new(object_store::local::LocalFileSystem::new_with_prefix(dir)?)
        }
        _ if url.starts_with("s3://") => Arc::new(
            object_store::aws::AmazonS3Builder::from_env()
                .with_bucket_name(&url["s3://".len()..])
                .build()?,
        ),
        _ => anyhow::bail!("CHAT_BLOB_STORE must be memory, file:///path or s3://bucket"),
    })
}

pub(crate) fn store(state: &AppState) -> Result<&Arc<dyn ObjectStore>, ApiError> {
    state.blobs.as_ref().ok_or(ApiError::Unavailable)
}

fn object_path(id: Uuid) -> Path {
    Path::from(format!("blobs/{id}"))
}

fn part_path(id: Uuid, part: i32) -> Path {
    Path::from(format!("blobs/{id}/{part}"))
}

/// Size of part `n` of an upload of `size` bytes.
fn part_len(size: u64, parts: i32, n: i32) -> u64 {
    if n + 1 < parts {
        UPLOAD_PART_BYTES
    } else {
        size - UPLOAD_PART_BYTES * (parts as u64 - 1)
    }
}

#[derive(Serialize)]
pub struct Uploaded {
    blob_id: Uuid,
    expires_in_days: i32,
}

/// `PUT /v1/blobs`: stores encrypted bytes (needs `Content-Length`).
pub async fn upload(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<Uploaded>, ApiError> {
    let db = db(&state)?;
    let store = store(&state)?.clone();
    let declared = content_length(&headers)?;
    take_quota(&state, device, declared).await?;
    let account = account_of(db, device).await?;
    let id = Uuid::new_v4();
    let key = object_path(id).to_string();
    storage::reserve(db, account, &[(key.clone(), declared as i64)]).await?;
    // Failed writes retain their reservations. Cancellation does not prove
    // that a remote multipart writer has stopped.
    let received = stream_to(&store, &object_path(id), declared, body).await?;
    storage::mark_ready(db, &key).await?;
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO blobs (blob_id, size_bytes, expires_at, account_id)
         VALUES ($1, $2, now() + make_interval(days => $3), $4)",
    )
    .bind(id)
    .bind(received as i64)
    .bind(BLOB_TTL_DAYS)
    .bind(account)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE storage_objects SET state = 'live' WHERE object_key = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(Uploaded {
        blob_id: id,
        expires_in_days: BLOB_TTL_DAYS,
    }))
}

/// Streams exactly `declared` bytes into a reserved, unique object key.
/// Failed and interrupted uploads retain their reservations. A successful
/// abort does not fence remote multipart work.
pub(crate) async fn stream_to(
    store: &Arc<dyn ObjectStore>,
    path: &Path,
    declared: u64,
    body: Body,
) -> Result<u64, ApiError> {
    let writer = WriteMultipart::new_with_chunk_size(
        store.put_multipart(path).await.map_err(internal)?,
        PART_BYTES,
    );
    stream_multipart(writer, declared, body).await
}

async fn stream_multipart(
    mut writer: WriteMultipart,
    declared: u64,
    body: Body,
) -> Result<u64, ApiError> {
    let mut received: u64 = 0;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk: Bytes = match chunk {
            Ok(c) => c,
            Err(_) => {
                let _ = writer.abort().await;
                return Err(ApiError::BadRequest("upload interrupted"));
            }
        };
        received += chunk.len() as u64;
        if received > declared {
            let _ = writer.abort().await;
            return Err(ApiError::BadRequest("more data than Content-Length"));
        }
        writer.write(&chunk);
    }
    if received != declared {
        let _ = writer.abort().await;
        return Err(ApiError::BadRequest("upload interrupted"));
    }
    writer.finish().await.map_err(internal)?;
    Ok(received)
}

pub(crate) fn content_length(headers: &HeaderMap) -> Result<u64, ApiError> {
    let declared: u64 = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or(ApiError::BadRequest("Content-Length is required"))?;
    if declared == 0 || declared > MAX_BLOB_BYTES {
        return Err(ApiError::BadRequest("attachments are 1 byte to 100 MB"));
    }
    Ok(declared)
}

/// Charges `bytes` to the device's daily upload allowance.
async fn take_quota(state: &AppState, device: Uuid, bytes: u64) -> Result<(), ApiError> {
    let megabytes = bytes.div_ceil(1024 * 1024) as i32;
    let key = format!("blob-mb:{device}");
    limits::take(
        db(state)?,
        &key,
        megabytes,
        state.limits.blob_mb_per_day,
        limits::DAY,
    )
    .await
}

async fn take_quota_in(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    device: Uuid,
    bytes: u64,
) -> Result<(), ApiError> {
    let megabytes = bytes.div_ceil(1024 * 1024) as i32;
    limits::tx_take(
        tx,
        &format!("blob-mb:{device}"),
        megabytes,
        state.limits.blob_mb_per_day,
        limits::DAY,
    )
    .await
}

/// The account that owns `device`.
async fn account_of(db: &PgPool, device: Uuid) -> Result<Uuid, ApiError> {
    let (account,): (Uuid,) = sqlx::query_as("SELECT account_id FROM devices WHERE device_id = $1")
        .bind(device)
        .fetch_one(db)
        .await?;
    Ok(account)
}

async fn account_of_in(tx: &mut Transaction<'_, Postgres>, device: Uuid) -> Result<Uuid, ApiError> {
    let (account,): (Uuid,) = sqlx::query_as("SELECT account_id FROM devices WHERE device_id = $1")
        .bind(device)
        .fetch_one(&mut **tx)
        .await?;
    Ok(account)
}

#[derive(Deserialize)]
pub struct NewUpload {
    size: u64,
    /// A caller-generated UUID. It is optional for legacy clients.
    transfer_id: Option<Uuid>,
    /// Lowercase 64-hex SHA-256 of the complete ciphertext. It is required
    /// with `transfer_id`, and never used as a storage object key.
    ciphertext_sha256: Option<String>,
}

#[derive(Serialize)]
pub struct UploadSession {
    upload_id: Uuid,
    part_bytes: u64,
    parts: i32,
    expires_in_hours: i32,
}

fn upload_session(upload_id: Uuid, size: u64) -> UploadSession {
    UploadSession {
        upload_id,
        part_bytes: UPLOAD_PART_BYTES,
        parts: size.div_ceil(UPLOAD_PART_BYTES) as i32,
        expires_in_hours: UPLOAD_TTL_HOURS,
    }
}

fn ciphertext_digest(value: Option<String>) -> Result<Option<Vec<u8>>, ApiError> {
    match value {
        None => Ok(None),
        Some(value) => {
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(ApiError::BadRequest(
                    "ciphertext_sha256 must be lowercase 64-hex SHA-256",
                ));
            }
            let digest = (0..32)
                .map(|index| u8::from_str_radix(&value[index * 2..index * 2 + 2], 16))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| {
                    ApiError::BadRequest("ciphertext_sha256 must be lowercase 64-hex SHA-256")
                })?;
            Ok(Some(digest))
        }
    }
}

/// `POST /v1/blobs/uploads`: starts a resumable upload of `size` bytes. The
/// whole size counts against today's allowance now. Clients that provide a
/// transfer id and ciphertext digest can safely retry a lost create response.
pub async fn create_upload(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    ApiJson(req): ApiJson<NewUpload>,
) -> Result<Json<UploadSession>, ApiError> {
    if req.size == 0 || req.size > MAX_BLOB_BYTES {
        return Err(ApiError::BadRequest("attachments are 1 byte to 100 MB"));
    }
    store(&state)?;
    let digest = ciphertext_digest(req.ciphertext_sha256)?;
    match (req.transfer_id, digest) {
        (None, None) => create_legacy_upload(&state, device, req.size).await,
        (Some(transfer_id), Some(digest)) => {
            create_idempotent_upload(&state, device, transfer_id, req.size, digest).await
        }
        _ => Err(ApiError::BadRequest(
            "transfer_id and ciphertext_sha256 must be supplied together",
        )),
    }
}

async fn create_legacy_upload(
    state: &AppState,
    device: Uuid,
    size: u64,
) -> Result<Json<UploadSession>, ApiError> {
    take_quota(state, device, size).await?;
    let account = account_of(db(state)?, device).await?;
    let id = Uuid::new_v4();
    let parts = size.div_ceil(UPLOAD_PART_BYTES) as i32;
    let objects: Vec<_> = (0..parts)
        .map(|n| {
            (
                part_path(id, n).to_string(),
                part_len(size, parts, n) as i64,
            )
        })
        .collect();
    storage::reserve(db(state)?, account, &objects).await?;
    sqlx::query(
        "INSERT INTO blob_uploads (upload_id, device_id, size_bytes, parts, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))",
    )
    .bind(id)
    .bind(device)
    .bind(size as i64)
    .bind(parts)
    .bind(UPLOAD_TTL_HOURS)
    .execute(db(state)?)
    .await?;
    Ok(Json(upload_session(id, size)))
}

async fn create_idempotent_upload(
    state: &AppState,
    device: Uuid,
    transfer_id: Uuid,
    size: u64,
    digest: Vec<u8>,
) -> Result<Json<UploadSession>, ApiError> {
    let database = db(state)?;
    let mut tx = database.begin().await?;
    // Serialize first use of this device-scoped caller key before any daily
    // or durable quota debit. Hash collisions only serialize unrelated creates.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))")
        .bind(format!("{device}:{transfer_id}"))
        .execute(&mut *tx)
        .await?;
    let existing: Option<(Uuid, i64, Vec<u8>, Uuid, String)> = sqlx::query_as(
        "SELECT device_id, size_bytes, ciphertext_sha256, upload_id, state
         FROM blob_upload_transfers WHERE device_id = $1 AND transfer_id = $2 FOR UPDATE",
    )
    .bind(device)
    .bind(transfer_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((owner, stored_size, stored_digest, upload_id, transfer_state)) = existing {
        debug_assert_eq!(owner, device, "device is part of the transfer key");
        if stored_size != size as i64 || stored_digest != digest {
            return Err(ApiError::Conflict("transfer parameters conflict"));
        }
        if transfer_state == "expired" {
            return Err(ApiError::Conflict("transfer expired"));
        }
        if transfer_state != "uploading" && transfer_state != "complete" {
            return Err(ApiError::Conflict("transfer is unavailable"));
        }
        tx.commit().await?;
        // A completed transfer returns its original upload id. Retrying its
        // completion recovers the stable blob id without new quota effects.
        return Ok(Json(upload_session(upload_id, size)));
    }

    let account = account_of_in(&mut tx, device).await?;
    let upload_id = Uuid::new_v4();
    let parts = size.div_ceil(UPLOAD_PART_BYTES) as i32;
    let objects: Vec<_> = (0..parts)
        .map(|n| {
            (
                part_path(upload_id, n).to_string(),
                part_len(size, parts, n) as i64,
            )
        })
        .collect();
    take_quota_in(state, &mut tx, device, size).await?;
    storage::reserve_in(&mut tx, account, &objects).await?;
    sqlx::query(
        "INSERT INTO blob_uploads (upload_id, device_id, size_bytes, parts, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))",
    )
    .bind(upload_id)
    .bind(device)
    .bind(size as i64)
    .bind(parts)
    .bind(UPLOAD_TTL_HOURS)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO blob_upload_transfers
         (transfer_id, device_id, size_bytes, ciphertext_sha256, upload_id, state)
         VALUES ($1, $2, $3, $4, $5, 'uploading')",
    )
    .bind(transfer_id)
    .bind(device)
    .bind(size as i64)
    .bind(digest)
    .bind(upload_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(upload_session(upload_id, size)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    transfer_idempotency: i32,
}

/// `GET /v1/blobs/capabilities`: authenticated feature discovery for clients.
pub async fn capabilities(AuthDevice(_device): AuthDevice) -> Json<Capabilities> {
    Json(Capabilities {
        transfer_idempotency: 1,
    })
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TransferStatus {
    Uploading { upload_id: Uuid },
    Complete { blob_id: Uuid },
}

/// `GET /v1/blobs/transfers/{transfer_id}`: recover lost create or completion
/// results without exposing another device's transfer state.
pub async fn transfer_status(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    UrlPath(transfer_id): UrlPath<Uuid>,
) -> Result<Json<TransferStatus>, ApiError> {
    let row: Option<(Uuid, String, Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT device_id, state, upload_id, blob_id FROM blob_upload_transfers
         WHERE device_id = $1 AND transfer_id = $2",
    )
    .bind(device)
    .bind(transfer_id)
    .fetch_optional(db(&state)?)
    .await?;
    let (owner, transfer_state, upload_id, blob_id) =
        row.ok_or(ApiError::NotFound("no such transfer"))?;
    debug_assert_eq!(owner, device, "device is part of the transfer key");
    match (transfer_state.as_str(), blob_id) {
        ("uploading", _) => Ok(Json(TransferStatus::Uploading { upload_id })),
        ("complete", Some(blob_id)) => Ok(Json(TransferStatus::Complete { blob_id })),
        ("expired", _) => Err(ApiError::Conflict("transfer expired")),
        _ => Err(ApiError::Conflict("transfer is unavailable")),
    }
}

/// Hash persisted multipart ciphertext in part order. Completion holds a
/// durable claim, not a database transaction, during these bounded reads.
async fn multipart_ciphertext_digest(
    store: &Arc<dyn ObjectStore>,
    id: Uuid,
    size: u64,
    parts: i32,
) -> Result<Vec<u8>, ApiError> {
    let mut hash = Sha256::new();
    for part in 0..parts {
        let length = part_len(size, parts, part);
        for start in (0..length).step_by(HASH_RANGE_BYTES as usize) {
            let end = (start + HASH_RANGE_BYTES).min(length);
            let mut stream = store
                .get_opts(
                    &part_path(id, part),
                    GetOptions::new().with_range(Some(start..end)),
                )
                .await
                .map_err(internal)?
                .into_stream();
            let mut received = 0_u64;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(internal)?;
                received += chunk.len() as u64;
                hash.update(chunk);
            }
            if received != end - start {
                return Err(ApiError::Conflict(
                    "stored ciphertext changed while completing",
                ));
            }
        }
    }
    Ok(hash.finalize().to_vec())
}

struct CompletionClaim {
    claim: Uuid,
    size: u64,
    parts: i32,
    digest: Option<Vec<u8>>,
}

async fn clear_completion_claim(db: &PgPool, id: Uuid, claim: Uuid) {
    if let Err(error) = sqlx::query(
        "UPDATE blob_uploads SET completion_claim = NULL, completion_claimed_at = NULL
         WHERE upload_id = $1 AND completion_claim = $2",
    )
    .bind(id)
    .bind(claim)
    .execute(db)
    .await
    {
        tracing::warn!(error = ?error, "completion claim cleanup failed");
    }
}

async fn claim_completion(
    state: &AppState,
    device: Uuid,
    id: Uuid,
) -> Result<Result<Uploaded, CompletionClaim>, ApiError> {
    let database = db(state)?;
    let mut tx = database.begin().await?;
    // A completed transfer survives upload-session cleanup and is the stable
    // answer for a lost completion response.
    let transfer: Option<(String, Option<Uuid>, Vec<u8>)> = sqlx::query_as(
        "SELECT state, blob_id, ciphertext_sha256 FROM blob_upload_transfers
         WHERE upload_id = $1 AND device_id = $2 FOR UPDATE",
    )
    .bind(id)
    .bind(device)
    .fetch_optional(&mut *tx)
    .await?;
    let digest = if let Some((transfer_state, blob_id, digest)) = transfer {
        match (transfer_state.as_str(), blob_id) {
            ("complete", Some(blob_id)) => {
                tx.commit().await?;
                return Ok(Ok(Uploaded {
                    blob_id,
                    expires_in_days: BLOB_TTL_DAYS,
                }));
            }
            ("expired", _) => return Err(ApiError::Conflict("transfer expired")),
            ("uploading", _) => Some(digest),
            _ => return Err(ApiError::Conflict("transfer is unavailable")),
        }
    } else {
        None
    };
    type CompletionStatusRow = (i64, i32, Vec<i32>, Option<Uuid>, Option<bool>);
    let row: Option<CompletionStatusRow> = sqlx::query_as(
        "SELECT size_bytes, parts, received, completion_claim,
                completion_claimed_at > now() - make_interval(secs => $3) AS claim_live
         FROM blob_uploads WHERE upload_id = $1 AND device_id = $2
         AND NOT retiring AND expires_at > now() FOR UPDATE",
    )
    .bind(id)
    .bind(device)
    .bind(f64::from(COMPLETION_CLAIM_TTL_SECS))
    .fetch_optional(&mut *tx)
    .await?;
    let (size, parts, received, existing_claim, claim_live) =
        row.ok_or(ApiError::NotFound("no such upload, or it expired"))?;
    if received.len() as i32 != parts {
        return Err(ApiError::Conflict("some parts are missing"));
    }
    let (count, ready): (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE state = 'ready') FROM storage_objects
         WHERE object_key LIKE $1",
    )
    .bind(format!("blobs/{id}/%"))
    .fetch_one(&mut *tx)
    .await?;
    if count != i64::from(parts) || ready != i64::from(parts) {
        return Err(ApiError::Conflict("some parts are still being written"));
    }
    if existing_claim.is_some() && claim_live.unwrap_or(true) {
        return Err(ApiError::Conflict("completion is already being verified"));
    }
    let claim = Uuid::new_v4();
    // A stale claim only permits a new verification pass. It can never publish
    // by age alone because promotion re-locks and compares this UUID.
    sqlx::query(
        "UPDATE blob_uploads SET completion_claim = $2, completion_claimed_at = now()
         WHERE upload_id = $1",
    )
    .bind(id)
    .bind(claim)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Err(CompletionClaim {
        claim,
        size: size as u64,
        parts,
        digest,
    }))
}

/// This device's live upload: (size, parts, received parts).
async fn upload_of(
    state: &AppState,
    device: Uuid,
    id: Uuid,
) -> Result<(u64, i32, Vec<i32>), ApiError> {
    let row: Option<(i64, i32, Vec<i32>)> = sqlx::query_as(
        "SELECT size_bytes, parts, received FROM blob_uploads
         WHERE upload_id = $1 AND device_id = $2 AND NOT retiring AND expires_at > now()",
    )
    .bind(id)
    .bind(device)
    .fetch_optional(db(state)?)
    .await?;
    let (size, parts, received) = row.ok_or(ApiError::NotFound("no such upload, or it expired"))?;
    Ok((size as u64, parts, received))
}

/// `PUT /v1/blobs/uploads/{id}/{part}`: one part, exactly `part_bytes`
/// long (the last may be shorter). Sending a part again replaces it.
pub async fn put_part(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    UrlPath((id, part)): UrlPath<(Uuid, i32)>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let (size, parts, _) = upload_of(&state, device, id).await?;
    if part < 0 || part >= parts {
        return Err(ApiError::BadRequest("no such part"));
    }
    if body.len() as u64 != part_len(size, parts, part) {
        return Err(ApiError::BadRequest("wrong part size"));
    }
    let db = db(&state)?;
    let key = part_path(id, part).to_string();
    let mut tx = db.begin().await?;
    // A short claim transaction fences completion and expiry. Never hold a
    // database transaction while the object store receives the part.
    let live: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT upload_id, completion_claim FROM blob_uploads
         WHERE upload_id = $1 AND device_id = $2 AND NOT retiring AND expires_at > now() FOR UPDATE",
    )
    .bind(id)
    .bind(device)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((_, completion_claim)) = live else {
        return Err(ApiError::NotFound("no such upload, or it expired"));
    };
    if completion_claim.is_some() {
        return Err(ApiError::Conflict("completion is already being verified"));
    }
    let claimed = sqlx::query(
        "UPDATE storage_objects SET state = 'writing'
         WHERE object_key = $1 AND state IN ('reserved', 'ready')",
    )
    .bind(&key)
    .execute(&mut *tx)
    .await?;
    if claimed.rows_affected() != 1 {
        return Err(ApiError::Conflict("this part is already being written"));
    }
    tx.commit().await?;
    store(&state)?
        .put(&part_path(id, part), PutPayload::from(body))
        .await
        .map_err(internal)?;
    let mut tx = db.begin().await?;
    sqlx::query(
        "UPDATE blob_uploads
         SET received = ARRAY(SELECT DISTINCT unnest(received || $2) ORDER BY 1)
         WHERE upload_id = $1",
    )
    .bind(id)
    .bind(part)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE storage_objects SET state = 'ready' WHERE object_key = $1")
        .bind(&key)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct UploadStatus {
    parts: i32,
    /// Parts stored so far, in order.
    received: Vec<i32>,
}

/// `GET /v1/blobs/uploads/{id}`: which parts arrived, to resume.
pub async fn upload_status(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    UrlPath(id): UrlPath<Uuid>,
) -> Result<Json<UploadStatus>, ApiError> {
    let (_, parts, received) = upload_of(&state, device, id).await?;
    Ok(Json(UploadStatus { parts, received }))
}

/// `POST /v1/blobs/uploads/{id}/complete`: once every part is stored, the
/// upload becomes a blob with the same id.
pub async fn complete_upload(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    UrlPath(id): UrlPath<Uuid>,
) -> Result<Json<Uploaded>, ApiError> {
    let claim = match claim_completion(&state, device, id).await? {
        Ok(uploaded) => return Ok(Json(uploaded)),
        Err(claim) => claim,
    };
    let actual_digest =
        multipart_ciphertext_digest(store(&state)?, id, claim.size, claim.parts).await;
    let actual_digest = match actual_digest {
        Ok(digest) => digest,
        Err(error) => {
            clear_completion_claim(db(&state)?, id, claim.claim).await;
            return Err(error);
        }
    };
    if let Some(declared_digest) = &claim.digest
        && actual_digest != *declared_digest
    {
        clear_completion_claim(db(&state)?, id, claim.claim).await;
        return Err(ApiError::Conflict(
            "ciphertext_sha256 does not match uploaded ciphertext",
        ));
    }
    match publish_completion(&state, device, id, &claim).await {
        Ok(uploaded) => Ok(Json(uploaded)),
        Err(error) => {
            clear_completion_claim(db(&state)?, id, claim.claim).await;
            Err(error)
        }
    }
}

async fn publish_completion(
    state: &AppState,
    device: Uuid,
    id: Uuid,
    claim: &CompletionClaim,
) -> Result<Uploaded, ApiError> {
    let database = db(state)?;
    let mut tx = database.begin().await?;
    // Match claim_completion's lock order. Locking the upload first would
    // deadlock with a competing claim that holds the transfer row.
    sqlx::query(
        "SELECT transfer_id FROM blob_upload_transfers
         WHERE upload_id = $1 AND device_id = $2 FOR UPDATE",
    )
    .bind(id)
    .bind(device)
    .fetch_optional(&mut *tx)
    .await?;
    // Re-lock after object-store I/O. A stale claim can only be reclaimed for
    // another full verification pass; it can never publish this hash result.
    let row: Option<(i64, i32, Vec<i32>)> = sqlx::query_as(
        "SELECT size_bytes, parts, received FROM blob_uploads
         WHERE upload_id = $1 AND device_id = $2 AND NOT retiring
         AND completion_claim = $3 FOR UPDATE",
    )
    .bind(id)
    .bind(device)
    .bind(claim.claim)
    .fetch_optional(&mut *tx)
    .await?;
    let (size, parts, received) = row.ok_or(ApiError::Conflict("completion claim was lost"))?;
    if size as u64 != claim.size || parts != claim.parts || received.len() as i32 != parts {
        return Err(ApiError::Conflict("upload changed while completing"));
    }
    let (count, ready): (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE state = 'ready') FROM storage_objects
         WHERE object_key LIKE $1",
    )
    .bind(format!("blobs/{id}/%"))
    .fetch_one(&mut *tx)
    .await?;
    if count != i64::from(parts) || ready != i64::from(parts) {
        return Err(ApiError::Conflict("some parts changed while completing"));
    }
    let account = account_of_in(&mut tx, device).await?;
    sqlx::query("DELETE FROM blob_uploads WHERE upload_id = $1 AND completion_claim = $2")
        .bind(id)
        .bind(claim.claim)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO blobs (blob_id, size_bytes, parts, expires_at, account_id)
         VALUES ($1, $2, $3, now() + make_interval(days => $4), $5)",
    )
    .bind(id)
    .bind(size)
    .bind(parts)
    .bind(BLOB_TTL_DAYS)
    .bind(account)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE storage_objects SET state = 'live' WHERE object_key LIKE $1")
        .bind(format!("blobs/{id}/%"))
        .execute(&mut *tx)
        .await?;
    // The mapping and the blob become visible in this same transaction.
    sqlx::query(
        "UPDATE blob_upload_transfers SET state = 'complete', blob_id = $2
         WHERE upload_id = $1 AND device_id = $3",
    )
    .bind(id)
    .bind(id)
    .bind(device)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Uploaded {
        blob_id: id,
        expires_in_days: BLOB_TTL_DAYS,
    })
}

/// A single `bytes=` range, clamped to `size`; `None` for the whole blob.
fn requested_range(headers: &HeaderMap, size: u64) -> Result<Option<(u64, u64)>, ApiError> {
    let Some(value) = headers.get(header::RANGE) else {
        return Ok(None);
    };
    let bad = || ApiError::RangeNotSatisfiable(size);
    let spec = value
        .to_str()
        .ok()
        .and_then(|v| v.strip_prefix("bytes="))
        .ok_or_else(bad)?;
    let (start, end) = spec.split_once('-').ok_or_else(bad)?;
    let start: u64 = start.trim().parse().map_err(|_| bad())?;
    let end: u64 = match end.trim() {
        "" => size - 1,
        e => e.parse::<u64>().map_err(|_| bad())?.min(size - 1),
    };
    if start > end {
        return Err(bad());
    }
    Ok(Some((start, end + 1)))
}

/// `GET /v1/blobs/{id}`: streams the encrypted bytes back, whole or one
/// `Range` (to resume). The random id is the capability; the content is
/// useless without the key in the message that referenced it.
pub async fn download(
    State(state): State<AppState>,
    AuthDevice(_device): AuthDevice,
    UrlPath(id): UrlPath<Uuid>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let db = db(&state)?;
    let live: Option<(i64, i32)> = sqlx::query_as(
        "SELECT size_bytes, parts FROM blobs WHERE blob_id = $1 AND expires_at > now()",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let (size, parts) = live.ok_or(ApiError::NotFound("no such attachment, or it expired"))?;
    let size = size as u64;
    let range = requested_range(&headers, size)?;
    let (start, end) = range.unwrap_or((0, size));
    // A blob id is a capability, so downloads are charged like uploads: a
    // leaked id must not turn into an unlimited download budget.
    let megabytes = ((end - start).div_ceil(1024 * 1024) as i32).max(1);
    limits::take(
        db,
        &format!("blob-dl:{_device}"),
        megabytes,
        state.limits.blob_mb_per_day,
        limits::DAY,
    )
    .await?;
    let store = store(&state)?.clone();
    // (object, byte range within it) for each object the range touches.
    let pieces: Vec<(Path, std::ops::Range<u64>)> = if parts == 0 {
        vec![(object_path(id), start..end)]
    } else {
        (0..parts)
            .filter_map(|n| {
                let from = n as u64 * UPLOAD_PART_BYTES;
                let to = from + part_len(size, parts, n);
                (from < end && to > start)
                    .then(|| (part_path(id, n), start.max(from) - from..end.min(to) - from))
            })
            .collect()
    };
    // Fail now, while a clean 404 is still possible.
    let first = store
        .get_opts(
            &pieces[0].0,
            GetOptions::new().with_range(Some(pieces[0].1.clone())),
        )
        .await
        .map_err(|_| ApiError::NotFound("no such attachment, or it expired"))?;
    let rest = stream::iter(pieces.into_iter().skip(1))
        .then(move |(path, r)| {
            let store = store.clone();
            async move {
                store
                    .get_opts(&path, GetOptions::new().with_range(Some(r)))
                    .await
                    .map(|g| g.into_stream())
            }
        })
        .try_flatten();
    let body = first
        .into_stream()
        .chain(rest)
        .map_err(std::io::Error::other);
    let mut response = (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CONTENT_LENGTH, (end - start).to_string()),
            (header::ACCEPT_RANGES, "bytes".to_owned()),
            // Immutable once written; the client caches nothing it can't decrypt.
            (
                header::CACHE_CONTROL,
                "private, max-age=86400, immutable".to_owned(),
            ),
        ],
        Body::from_stream(body),
    )
        .into_response();
    if range.is_some() {
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{size}", end - 1)
                .parse()
                .expect("ascii"),
        );
    }
    Ok(response)
}

/// Deletes objects, treating ones already gone as deleted.
async fn delete_all(db: &PgPool, store: &Arc<dyn ObjectStore>, paths: Vec<Path>) -> bool {
    for path in paths {
        if let Err(e) = storage::forget(store, db, path.as_ref()).await {
            tracing::warn!(error = ?e, "deleting an expired blob failed");
            return false;
        }
    }
    true
}

/// Deletes expired blobs and abandoned uploads from the store and the
/// tables (hourly).
pub async fn expire(db: &sqlx::PgPool, store: &Arc<dyn ObjectStore>) -> anyhow::Result<()> {
    // A crash can leave a completion claim. Clearing a stale claim never
    // publishes it: any completer must re-lock the exact claim after rehashing.
    sqlx::query(
        "UPDATE blob_uploads SET completion_claim = NULL, completion_claimed_at = NULL
         WHERE completion_claim IS NOT NULL
         AND completion_claimed_at <= now() - make_interval(secs => $1)",
    )
    .bind(f64::from(COMPLETION_CLAIM_TTL_SECS))
    .execute(db)
    .await?;
    let expired: Vec<(Uuid, i32)> = sqlx::query_as(
        "SELECT blob_id, parts FROM blobs WHERE expires_at < now() ORDER BY expires_at LIMIT 1000",
    )
    .fetch_all(db)
    .await?;
    for (id, parts) in expired {
        let paths = if parts == 0 {
            vec![object_path(id)]
        } else {
            (0..parts).map(|n| part_path(id, n)).collect()
        };
        if delete_all(db, store, paths).await {
            let mut tx = db.begin().await?;
            // Retain the UUID and digest fence after object deletion, but do
            // not report a deleted blob as complete to a recovering client.
            sqlx::query(
                "UPDATE blob_upload_transfers SET state = 'expired'
                 WHERE blob_id = $1 AND state = 'complete'",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM blobs WHERE blob_id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
    }
    let abandoned: Vec<(Uuid, i32)> = sqlx::query_as(
        "SELECT u.upload_id, u.parts FROM blob_uploads u WHERE u.expires_at < now()
         AND u.completion_claim IS NULL
         AND NOT EXISTS (SELECT 1 FROM storage_objects s
                         WHERE s.object_key LIKE 'blobs/' || u.upload_id || '/%'
                           AND s.state = 'writing')
         ORDER BY u.expires_at LIMIT 1000",
    )
    .fetch_all(db)
    .await?;
    for (id, parts) in abandoned {
        let mut tx = db.begin().await?;
        // An expired session cannot accept a new writer. The row lock waits
        // for earlier claims. A crashed writer retains its charge forever,
        // until an operator fences it and repairs the reservation.
        let expired: Option<(Uuid,)> = sqlx::query_as(
            "SELECT upload_id FROM blob_uploads WHERE upload_id = $1
             AND expires_at < now() AND completion_claim IS NULL FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        let (writing,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM storage_objects WHERE object_key LIKE $1 AND state = 'writing'",
        )
        .bind(format!("blobs/{id}/%"))
        .fetch_one(&mut *tx)
        .await?;
        if expired.is_none() || writing != 0 {
            tx.rollback().await?;
            continue;
        }
        // A transaction can wait for this lock with a pre-expiry now(). A
        // durable flag, not its transaction timestamp, must fence that writer.
        sqlx::query("UPDATE blob_uploads SET retiring = TRUE WHERE upload_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        if delete_all(db, store, (0..parts).map(|n| part_path(id, n)).collect()).await {
            let mut tx = db.begin().await?;
            sqlx::query(
                "UPDATE blob_upload_transfers SET state = 'expired'
                 WHERE upload_id = $1 AND state = 'uploading'",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM blob_uploads WHERE upload_id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
    }
    Ok(())
}

pub(crate) fn internal(e: object_store::Error) -> ApiError {
    ApiError::Internal(e.into())
}

#[cfg(test)]
mod multipart_tests {
    use super::*;
    use object_store::{MultipartUpload, PutResult, UploadPart};
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Debug)]
    struct UnfencedUpload {
        remote_work: Arc<AtomicBool>,
        aborted: Arc<AtomicBool>,
    }

    impl MultipartUpload for UnfencedUpload {
        fn put_part(&mut self, _: PutPayload) -> UploadPart {
            // The remote request can outlive the local future.
            self.remote_work.store(true, Ordering::SeqCst);
            Box::pin(std::future::pending())
        }

        fn complete<'a, 'async_trait>(
            &'a mut self,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = object_store::Result<PutResult>>
                    + Send
                    + 'async_trait,
            >,
        >
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            Box::pin(async { panic!("short body must not complete") })
        }

        fn abort<'a, 'async_trait>(
            &'a mut self,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = object_store::Result<()>> + Send + 'async_trait>,
        >
        where
            'a: 'async_trait,
            Self: 'async_trait,
        {
            self.aborted.store(true, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn successful_abort_does_not_fence_remote_part_or_release_reservation() {
        let remote_work = Arc::new(AtomicBool::new(false));
        let aborted = Arc::new(AtomicBool::new(false));
        let writer = WriteMultipart::new_with_chunk_size(
            Box::new(UnfencedUpload {
                remote_work: remote_work.clone(),
                aborted: aborted.clone(),
            }),
            2,
        );
        // This function has no ledger access, so it cannot release the charge.
        let result = stream_multipart(writer, 3, Body::from(vec![1, 2])).await;
        assert!(matches!(
            result,
            Err(ApiError::BadRequest("upload interrupted"))
        ));
        assert!(aborted.load(Ordering::SeqCst));
        assert!(remote_work.load(Ordering::SeqCst));
    }
}

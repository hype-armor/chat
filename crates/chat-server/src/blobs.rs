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
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, db},
    error::ApiError,
    limits,
};

/// 100 MB of content plus room for encryption overhead (FR-MED-3).
pub const MAX_BLOB_BYTES: u64 = 100 * 1024 * 1024 + 1024 * 1024;
const BLOB_TTL_DAYS: i32 = 30;
/// Multipart chunk size; S3 needs at least 5 MB per part.
const PART_BYTES: usize = 8 * 1024 * 1024;
/// Parts of a resumable upload; all but the last are exactly this size.
pub const UPLOAD_PART_BYTES: u64 = 8 * 1024 * 1024;
const UPLOAD_TTL_HOURS: i32 = 24;

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

    let id = Uuid::new_v4();
    let received = stream_to(&store, &object_path(id), declared, body).await?;
    sqlx::query(
        "INSERT INTO blobs (blob_id, size_bytes, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3))",
    )
    .bind(id)
    .bind(received as i64)
    .bind(BLOB_TTL_DAYS)
    .execute(db)
    .await?;
    Ok(Json(Uploaded {
        blob_id: id,
        expires_in_days: BLOB_TTL_DAYS,
    }))
}

/// Streams a request body of exactly `declared` bytes into a new object;
/// nothing is left behind if it falls short or runs over.
pub(crate) async fn stream_to(
    store: &Arc<dyn ObjectStore>,
    path: &Path,
    declared: u64,
    body: Body,
) -> Result<u64, ApiError> {
    let mut writer = WriteMultipart::new_with_chunk_size(
        store.put_multipart(path).await.map_err(internal)?,
        PART_BYTES,
    );
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

#[derive(Deserialize)]
pub struct NewUpload {
    size: u64,
}

#[derive(Serialize)]
pub struct UploadSession {
    upload_id: Uuid,
    part_bytes: u64,
    parts: i32,
    expires_in_hours: i32,
}

/// `POST /v1/blobs/uploads`: starts a resumable upload of `size` bytes. The
/// whole size counts against today's allowance now.
pub async fn create_upload(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<NewUpload>,
) -> Result<Json<UploadSession>, ApiError> {
    if req.size == 0 || req.size > MAX_BLOB_BYTES {
        return Err(ApiError::BadRequest("attachments are 1 byte to 100 MB"));
    }
    store(&state)?;
    take_quota(&state, device, req.size).await?;
    let id = Uuid::new_v4();
    let parts = req.size.div_ceil(UPLOAD_PART_BYTES) as i32;
    sqlx::query(
        "INSERT INTO blob_uploads (upload_id, device_id, size_bytes, parts, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))",
    )
    .bind(id)
    .bind(device)
    .bind(req.size as i64)
    .bind(parts)
    .bind(UPLOAD_TTL_HOURS)
    .execute(db(&state)?)
    .await?;
    Ok(Json(UploadSession {
        upload_id: id,
        part_bytes: UPLOAD_PART_BYTES,
        parts,
        expires_in_hours: UPLOAD_TTL_HOURS,
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
         WHERE upload_id = $1 AND device_id = $2 AND expires_at > now()",
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
    store(&state)?
        .put(&part_path(id, part), PutPayload::from(body))
        .await
        .map_err(internal)?;
    sqlx::query(
        "UPDATE blob_uploads
         SET received = ARRAY(SELECT DISTINCT unnest(received || $2) ORDER BY 1)
         WHERE upload_id = $1",
    )
    .bind(id)
    .bind(part)
    .execute(db(&state)?)
    .await?;
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
    let mut tx = db(&state)?.begin().await?;
    let row: Option<(i64, i32, Vec<i32>)> = sqlx::query_as(
        "SELECT size_bytes, parts, received FROM blob_uploads
         WHERE upload_id = $1 AND device_id = $2 AND expires_at > now() FOR UPDATE",
    )
    .bind(id)
    .bind(device)
    .fetch_optional(&mut *tx)
    .await?;
    let (size, parts, received) = row.ok_or(ApiError::NotFound("no such upload, or it expired"))?;
    if received.len() as i32 != parts {
        return Err(ApiError::Conflict("some parts are missing"));
    }
    sqlx::query("DELETE FROM blob_uploads WHERE upload_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO blobs (blob_id, size_bytes, parts, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4))",
    )
    .bind(id)
    .bind(size)
    .bind(parts)
    .bind(BLOB_TTL_DAYS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(Uploaded {
        blob_id: id,
        expires_in_days: BLOB_TTL_DAYS,
    }))
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
async fn delete_all(store: &Arc<dyn ObjectStore>, paths: Vec<Path>) -> bool {
    for path in paths {
        match store.delete(&path).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
            Err(e) => {
                tracing::warn!(error = %e, "deleting an expired blob failed");
                return false;
            }
        }
    }
    true
}

/// Deletes expired blobs and abandoned uploads from the store and the
/// tables (hourly).
pub async fn expire(db: &sqlx::PgPool, store: &Arc<dyn ObjectStore>) -> anyhow::Result<()> {
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
        if delete_all(store, paths).await {
            sqlx::query("DELETE FROM blobs WHERE blob_id = $1")
                .bind(id)
                .execute(db)
                .await?;
        }
    }
    let abandoned: Vec<(Uuid, Vec<i32>)> = sqlx::query_as(
        "SELECT upload_id, received FROM blob_uploads WHERE expires_at < now()
         ORDER BY expires_at LIMIT 1000",
    )
    .fetch_all(db)
    .await?;
    for (id, received) in abandoned {
        if delete_all(
            store,
            received.into_iter().map(|n| part_path(id, n)).collect(),
        )
        .await
        {
            sqlx::query("DELETE FROM blob_uploads WHERE upload_id = $1")
                .bind(id)
                .execute(db)
                .await?;
        }
    }
    Ok(())
}

pub(crate) fn internal(e: object_store::Error) -> ApiError {
    ApiError::Internal(e.into())
}

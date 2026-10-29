//! Encrypted attachments (FR-MED-2/3, ADR-0023). Clients encrypt before
//! upload; the server only stores ciphertext, streams it through to an
//! object store (S3-compatible in production) and deletes it after 30 days.

use std::sync::Arc;

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path as UrlPath, State},
    http::{HeaderMap, header},
    response::IntoResponse,
};
use futures_util::{StreamExt, TryStreamExt};
use object_store::{ObjectStore, ObjectStoreExt, WriteMultipart, path::Path};
use serde::Serialize;
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

/// Opens the store named by `CHAT_BLOB_STORE`: `memory` (development),
/// `file:///path`, or `s3://bucket` with the usual `AWS_*` variables
/// (`AWS_ENDPOINT` for MinIO).
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

fn store(state: &AppState) -> Result<&Arc<dyn ObjectStore>, ApiError> {
    state.blobs.as_ref().ok_or(ApiError::Unavailable)
}

fn object_path(id: Uuid) -> Path {
    Path::from(format!("blobs/{id}"))
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
    let declared: u64 = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or(ApiError::BadRequest("Content-Length is required"))?;
    if declared == 0 || declared > MAX_BLOB_BYTES {
        return Err(ApiError::BadRequest("attachments are 1 byte to 100 MB"));
    }
    let megabytes = declared.div_ceil(1024 * 1024) as i32;
    let key = format!("blob-mb:{device}");
    limits::take(
        db,
        &key,
        megabytes,
        state.limits.blob_mb_per_day,
        limits::DAY,
    )
    .await?;

    let id = Uuid::new_v4();
    let path = object_path(id);
    let mut writer = WriteMultipart::new_with_chunk_size(
        store.put_multipart(&path).await.map_err(internal)?,
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

/// `GET /v1/blobs/{id}`: streams the encrypted bytes back. The random id
/// is the capability; the content is useless without the key in the
/// message that referenced it.
pub async fn download(
    State(state): State<AppState>,
    AuthDevice(_device): AuthDevice,
    UrlPath(id): UrlPath<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let db = db(&state)?;
    let live: Option<(i64,)> =
        sqlx::query_as("SELECT size_bytes FROM blobs WHERE blob_id = $1 AND expires_at > now()")
            .bind(id)
            .fetch_optional(db)
            .await?;
    let (size,) = live.ok_or(ApiError::NotFound("no such attachment, or it expired"))?;
    let object = store(&state)?
        .get(&object_path(id))
        .await
        .map_err(|_| ApiError::NotFound("no such attachment, or it expired"))?;
    let stream = object.into_stream().map_err(std::io::Error::other);
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CONTENT_LENGTH, size.to_string()),
            // Immutable once written; the client caches nothing it can't decrypt.
            (
                header::CACHE_CONTROL,
                "private, max-age=86400, immutable".to_owned(),
            ),
        ],
        Body::from_stream(stream),
    ))
}

/// Deletes expired blobs from the store and the table (hourly).
pub async fn expire(db: &sqlx::PgPool, store: &Arc<dyn ObjectStore>) -> anyhow::Result<()> {
    let expired: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT blob_id FROM blobs WHERE expires_at < now() ORDER BY expires_at LIMIT 1000",
    )
    .fetch_all(db)
    .await?;
    for (id,) in expired {
        match store.delete(&object_path(id)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => {
                sqlx::query("DELETE FROM blobs WHERE blob_id = $1")
                    .bind(id)
                    .execute(db)
                    .await?;
            }
            Err(e) => tracing::warn!(error = %e, "deleting an expired blob failed"),
        }
    }
    Ok(())
}

fn internal(e: object_store::Error) -> ApiError {
    ApiError::Internal(e.into())
}

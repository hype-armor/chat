//! Shared object-store ciphertext quotas. The singleton policy row serializes
//! reservations and policy changes across replicas. Every ledger row counts.
//!
//! Uncertain failures and interrupted processes retain their reservations. An
//! operator must stop/fence writers and inspect storage before removing those
//! rows. Expiry alone is not proof that a writer has stopped. Account deletion
//! preserves ledger rows as global usage, with a NULL owner.

use std::sync::Arc;

use axum::{Json, extract::State};
use object_store::{ObjectStore, ObjectStoreExt, path::Path};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, db},
    error::ApiError,
};

/// Account-visible totals separate committed bytes from reservations.
#[derive(Debug, Serialize)]
pub struct Usage {
    /// Committed charges. Add reserved_bytes for the total quota charge.
    pub used_bytes: i64,
    pub reserved_bytes: i64,
    pub limit_bytes: Option<i64>,
    pub overridden: bool,
}

/// `GET /v1/storage`: returns only the authenticated account's usage and cap.
pub async fn usage(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
) -> Result<Json<Usage>, ApiError> {
    let db = db(&state)?;
    let account: Option<(Uuid,)> =
        sqlx::query_as("SELECT account_id FROM devices WHERE device_id = $1")
            .bind(device)
            .fetch_optional(db)
            .await?;
    let (account,) = account.ok_or(ApiError::Unauthorized("invalid token"))?;
    Ok(Json(account_usage(db, account).await?))
}

pub async fn account_usage(db: &PgPool, account: Uuid) -> Result<Usage, ApiError> {
    let (used_bytes, reserved_bytes, limit_bytes, overridden): (i64, i64, Option<i64>, bool) = sqlx::query_as(
        "SELECT (SELECT coalesce(sum(size_bytes), 0)::bigint FROM storage_objects WHERE account_id = $1 AND state = 'live'),
                (SELECT coalesce(sum(size_bytes), 0)::bigint FROM storage_objects WHERE account_id = $1 AND state <> 'live'),
                CASE WHEN a.account_id IS NULL THEN p.account_bytes ELSE a.limit_bytes END,
                a.account_id IS NOT NULL
         FROM storage_policy p LEFT JOIN account_storage_policy a ON a.account_id = $1 WHERE p.id = 1",
    )
    .bind(account)
    .fetch_one(db)
    .await?;
    Ok(Usage {
        used_bytes,
        reserved_bytes,
        limit_bytes,
        overridden,
    })
}

/// Reserves all physical object keys in one short transaction, before writes.
/// Callers must use fresh keys. A repeated reservation is not another upload.
pub async fn reserve(
    db: &PgPool,
    account: Uuid,
    objects: &[(String, i64)],
) -> Result<(), ApiError> {
    let mut tx = db.begin().await?;
    let (server_limit, default_limit): (Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT server_bytes, account_bytes FROM storage_policy WHERE id = 1 FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await?;
    let override_limit: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT limit_bytes FROM account_storage_policy WHERE account_id = $1")
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?;
    let account_limit = override_limit.map_or(default_limit, |(limit,)| limit);
    let mut requested = 0_i64;
    for (_, size) in objects {
        if *size <= 0 {
            return Err(ApiError::BadRequest("invalid storage reservation"));
        }
        requested = requested
            .checked_add(*size)
            .ok_or(ApiError::BadRequest("storage size overflow"))?;
    }
    let (server_used, account_used): (i64, i64) = sqlx::query_as(
        "SELECT coalesce(sum(size_bytes), 0)::bigint,
                coalesce(sum(size_bytes) FILTER (WHERE account_id = $1), 0)::bigint FROM storage_objects",
    )
    .bind(account)
    .fetch_one(&mut *tx)
    .await?;
    if exceeds(server_used, requested, server_limit) {
        return Err(ApiError::TooManyRequests("server storage quota reached"));
    }
    if exceeds(account_used, requested, account_limit) {
        return Err(ApiError::TooManyRequests("account storage quota reached"));
    }
    for (key, size) in objects {
        sqlx::query(
            "INSERT INTO storage_objects (object_key, account_id, size_bytes) VALUES ($1, $2, $3)",
        )
        .bind(key)
        .bind(account)
        .bind(size)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

fn exceeds(used: i64, requested: i64, limit: Option<i64>) -> bool {
    used.checked_add(requested)
        .is_none_or(|total| limit.is_some_and(|cap| total > cap))
}

/// Direct uploads have unique keys. Their writes never overlap cleanup.
pub(crate) async fn mark_ready(db: &PgPool, key: &str) -> Result<(), ApiError> {
    sqlx::query("UPDATE storage_objects SET state = 'ready' WHERE object_key = $1")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

/// Deletes a fenced object, then releases its charge. Never call while a
/// writer can still publish this key. NotFound also confirms deletion.
/// Database failures retain the charge, which makes retries conservative.
pub async fn forget(store: &Arc<dyn ObjectStore>, db: &PgPool, key: &str) -> Result<(), ApiError> {
    match store.delete(&Path::from(key)).await {
        Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
        Err(e) => return Err(ApiError::Internal(e.into())),
    }
    sqlx::query("DELETE FROM storage_objects WHERE object_key = $1")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

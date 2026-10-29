//! Key directory: MLS key packages and contact lookup.

use std::collections::HashMap;

use axum::{Json, extract::State, http::StatusCode};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, db, valid_phone},
    error::ApiError,
};

const MAX_KEY_PACKAGE_BYTES: usize = 4096;
const MAX_UPLOAD: usize = 100;
const MAX_STORED_PER_DEVICE: i64 = 200;
const MAX_CLAIM: usize = 200;
const KEY_PACKAGE_TTL_DAYS: i32 = 30;

#[derive(Deserialize)]
pub struct Upload {
    /// Base64 TLS-serialized MLS key packages.
    key_packages: Vec<String>,
}

pub async fn upload(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<Upload>,
) -> Result<StatusCode, ApiError> {
    let db = db(&state)?;
    if req.key_packages.is_empty() || req.key_packages.len() > MAX_UPLOAD {
        return Err(ApiError::BadRequest("upload 1 to 100 key packages"));
    }
    let packages = req
        .key_packages
        .iter()
        .map(|kp| {
            STANDARD
                .decode(kp)
                .ok()
                .filter(|b| !b.is_empty() && b.len() <= MAX_KEY_PACKAGE_BYTES)
        })
        .collect::<Option<Vec<_>>>()
        .ok_or(ApiError::BadRequest(
            "key packages must be base64, at most 4096 bytes each",
        ))?;

    let mut tx = db.begin().await?;
    let (stored,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM key_packages WHERE device_id = $1 AND expires_at > now()",
    )
    .bind(device)
    .fetch_one(&mut *tx)
    .await?;
    if stored + packages.len() as i64 > MAX_STORED_PER_DEVICE {
        return Err(ApiError::BadRequest("too many unused key packages stored"));
    }
    sqlx::query(
        "INSERT INTO key_packages (device_id, key_package, expires_at)
         SELECT $1, kp, now() + make_interval(days => $3) FROM UNNEST($2::bytea[]) AS kp",
    )
    .bind(device)
    .bind(&packages)
    .bind(KEY_PACKAGE_TTL_DAYS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Claim {
    device_ids: Vec<Uuid>,
}

#[derive(Serialize)]
pub struct Claimed {
    /// One single-use key package per device that still had one.
    key_packages: HashMap<Uuid, String>,
}

pub async fn claim(
    State(state): State<AppState>,
    AuthDevice(_): AuthDevice,
    Json(req): Json<Claim>,
) -> Result<Json<Claimed>, ApiError> {
    let db = db(&state)?;
    if req.device_ids.is_empty() || req.device_ids.len() > MAX_CLAIM {
        return Err(ApiError::BadRequest("claim for 1 to 200 devices"));
    }
    let rows: Vec<(Uuid, Vec<u8>)> = sqlx::query_as(
        // Oldest unexpired package per device; SKIP LOCKED lets concurrent
        // claims for the same device each take a different package.
        "DELETE FROM key_packages k USING (
             SELECT (SELECT key_package_id FROM key_packages
                     WHERE device_id = d AND expires_at > now()
                     ORDER BY key_package_id LIMIT 1 FOR UPDATE SKIP LOCKED) AS id
             FROM UNNEST($1::uuid[]) AS d) pick
         WHERE k.key_package_id = pick.id
         RETURNING k.device_id, k.key_package",
    )
    .bind(&req.device_ids)
    .fetch_all(db)
    .await?;
    let key_packages = rows
        .into_iter()
        .map(|(d, kp)| (d, STANDARD.encode(kp)))
        .collect();
    Ok(Json(Claimed { key_packages }))
}

#[derive(Deserialize)]
pub struct Lookup {
    phone: String,
}

#[derive(Serialize)]
pub struct Account {
    account_id: Uuid,
    device_ids: Vec<Uuid>,
}

/// Finds one contact by phone number. No bulk lookup (docs/04 §4).
pub async fn lookup(
    State(state): State<AppState>,
    AuthDevice(_): AuthDevice,
    Json(req): Json<Lookup>,
) -> Result<Json<Account>, ApiError> {
    let db = db(&state)?;
    if !valid_phone(&req.phone) {
        return Err(ApiError::BadRequest("phone must be in E.164 format"));
    }
    let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT a.account_id, d.device_id FROM accounts a
         JOIN devices d USING (account_id) WHERE a.phone_number = $1 ORDER BY d.created_at",
    )
    .bind(&req.phone)
    .fetch_all(db)
    .await?;
    let account_id = rows
        .first()
        .ok_or(ApiError::NotFound("no account for that number"))?
        .0;
    Ok(Json(Account {
        account_id,
        device_ids: rows.into_iter().map(|(_, d)| d).collect(),
    }))
}

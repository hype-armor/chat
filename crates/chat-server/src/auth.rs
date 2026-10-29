//! Phone verification, device registration and bearer-token auth.

use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{StatusCode, header::AUTHORIZATION, request::Parts},
};
use base64::{Engine, engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{AppState, error::ApiError};

const CODE_TTL_MINUTES: i32 = 10;
const MAX_CODE_ATTEMPTS: i32 = 5;
const MAX_CODES_PER_15_MIN: i64 = 3;
const MAX_CODES_PER_DAY: i64 = 10;
const MAX_DEVICES_PER_ACCOUNT: i64 = 10;

/// E.164: `+`, country code, up to 15 digits in total.
pub fn valid_phone(phone: &str) -> bool {
    let Some(digits) = phone.strip_prefix('+') else {
        return false;
    };
    (8..=15).contains(&digits.len())
        && digits.bytes().all(|b| b.is_ascii_digit())
        && !digits.starts_with('0')
}

fn code_hash(phone: &str, code: &str) -> Vec<u8> {
    Sha256::new()
        .chain_update(phone)
        .chain_update(b":")
        .chain_update(code)
        .finalize()
        .to_vec()
}

pub fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub fn db(state: &AppState) -> Result<&PgPool, ApiError> {
    state.db.as_ref().ok_or(ApiError::Unavailable)
}

#[derive(Deserialize)]
pub struct RequestCode {
    phone: String,
}

pub async fn request_code(
    State(state): State<AppState>,
    Json(req): Json<RequestCode>,
) -> Result<StatusCode, ApiError> {
    let db = db(&state)?;
    if !valid_phone(&req.phone) {
        return Err(ApiError::BadRequest(
            "phone must be in E.164 format, e.g. +15551234567",
        ));
    }
    let (recent, today): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE requested_at > now() - interval '15 minutes'), count(*)
         FROM code_requests WHERE phone_number = $1 AND requested_at > now() - interval '1 day'",
    )
    .bind(&req.phone)
    .fetch_one(db)
    .await?;
    if recent >= MAX_CODES_PER_15_MIN || today >= MAX_CODES_PER_DAY {
        return Err(ApiError::TooManyRequests(
            "too many codes requested; try again later",
        ));
    }

    let code = format!("{:06}", rand::random_range(0..1_000_000u32));
    let mut tx = db.begin().await?;
    sqlx::query("INSERT INTO code_requests (phone_number) VALUES ($1)")
        .bind(&req.phone)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO verification_codes (phone_number, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))
         ON CONFLICT (phone_number) DO UPDATE
         SET code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at",
    )
    .bind(&req.phone)
    .bind(code_hash(&req.phone, &code))
    .bind(CODE_TTL_MINUTES)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    state
        .sms
        .send(&req.phone, &code)
        .await
        .map_err(ApiError::Internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Verify {
    phone: String,
    code: String,
    /// Base64 device identity public key.
    identity_key: String,
}

#[derive(Serialize)]
pub struct Registered {
    account_id: Uuid,
    device_id: Uuid,
    /// Bearer token for REST calls and the WebSocket `Authenticate` frame.
    token: String,
}

pub async fn verify(
    State(state): State<AppState>,
    Json(req): Json<Verify>,
) -> Result<Json<Registered>, ApiError> {
    let db = db(&state)?;
    let identity_key = STANDARD
        .decode(&req.identity_key)
        .ok()
        .filter(|k| (1..=256).contains(&k.len()))
        .ok_or(ApiError::BadRequest(
            "identity_key must be base64, at most 256 bytes",
        ))?;

    let mut tx = db.begin().await?;
    let row: Option<(Vec<u8>, i32)> = sqlx::query_as(
        "SELECT code_hash, attempts FROM verification_codes
         WHERE phone_number = $1 AND expires_at > now() FOR UPDATE",
    )
    .bind(&req.phone)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((expected, attempts)) = row else {
        return Err(ApiError::Unauthorized("invalid or expired code"));
    };
    if attempts >= MAX_CODE_ATTEMPTS {
        return Err(ApiError::TooManyRequests(
            "too many attempts; request a new code",
        ));
    }
    if code_hash(&req.phone, &req.code) != expected {
        sqlx::query(
            "UPDATE verification_codes SET attempts = attempts + 1 WHERE phone_number = $1",
        )
        .bind(&req.phone)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(ApiError::Unauthorized("invalid or expired code"));
    }
    sqlx::query("DELETE FROM verification_codes WHERE phone_number = $1")
        .bind(&req.phone)
        .execute(&mut *tx)
        .await?;

    let (account_id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO accounts (account_id, phone_number) VALUES ($1, $2)
         ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
         RETURNING account_id",
    )
    .bind(Uuid::new_v4())
    .bind(&req.phone)
    .fetch_one(&mut *tx)
    .await?;
    let (devices,): (i64,) = sqlx::query_as("SELECT count(*) FROM devices WHERE account_id = $1")
        .bind(account_id)
        .fetch_one(&mut *tx)
        .await?;
    if devices >= MAX_DEVICES_PER_ACCOUNT {
        return Err(ApiError::BadRequest(
            "device limit reached; remove a device first",
        ));
    }

    let token = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let device_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO devices (device_id, account_id, identity_key, auth_token_hash, last_seen_day)
         VALUES ($1, $2, $3, $4, current_date)",
    )
    .bind(device_id)
    .bind(account_id)
    .bind(identity_key)
    .bind(token_hash(&token))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(Registered {
        account_id,
        device_id,
        token,
    }))
}

/// Resolves a bearer token to its device, recording a coarse last-seen day.
pub async fn device_for_token(db: &PgPool, token: &str) -> Result<Option<Uuid>, ApiError> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "UPDATE devices SET last_seen_day = current_date WHERE auth_token_hash = $1 RETURNING device_id",
    )
    .bind(token_hash(token))
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id,)| id))
}

/// Extractor for handlers that need an authenticated device.
pub struct AuthDevice(pub Uuid);

impl FromRequestParts<AppState> for AuthDevice {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(ApiError::Unauthorized("missing bearer token"))?;
        device_for_token(db(state)?, token)
            .await?
            .map(AuthDevice)
            .ok_or(ApiError::Unauthorized("invalid token"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_validation() {
        for ok in ["+15551234567", "+447700900123", "+12345678"] {
            assert!(valid_phone(ok), "{ok}");
        }
        for bad in [
            "15551234567",
            "+0555123456",
            "+1555",
            "+1555123456789012",
            "+1555-123-4567",
            "",
        ] {
            assert!(!valid_phone(bad), "{bad}");
        }
    }
}

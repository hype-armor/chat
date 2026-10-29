//! Sign-up by username (ADR-0021), device registration and bearer-token auth.

use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{header::AUTHORIZATION, request::Parts},
};
use base64::{Engine, engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState,
    error::ApiError,
    invites,
    limits::{self, ClientIp},
};

const MAX_DEVICES_PER_ACCOUNT: i64 = 10;

/// `name.NN`: 3–20 characters starting with a letter (`a–z`, `0–9`, `_`),
/// a dot and 2–4 digits. Returns the lowercase form.
pub fn normalize_username(raw: &str) -> Option<String> {
    let username = raw.trim().to_ascii_lowercase();
    let (name, digits) = username.split_once('.')?;
    let name_ok = (3..=20).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    let digits_ok = (2..=4).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit());
    (name_ok && digits_ok).then_some(username)
}

pub fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub fn db(state: &AppState) -> Result<&PgPool, ApiError> {
    state.db.as_ref().ok_or(ApiError::Unavailable)
}

#[derive(Deserialize)]
pub struct Register {
    username: String,
    /// Required while sign-up is invite-only (`CHAT_REGISTRATION=invite`).
    invite: Option<String>,
    /// Base64 device identity public key.
    identity_key: String,
}

#[derive(Serialize)]
pub struct Registered {
    account_id: Uuid,
    pub device_id: Uuid,
    /// Bearer token for REST calls and the WebSocket `Authenticate` frame.
    token: String,
    username: String,
}

/// Creates an account and its first device (ADR-0021).
pub async fn register(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(req): Json<Register>,
) -> Result<Json<Registered>, ApiError> {
    let db = db(&state)?;
    let username = normalize_username(&req.username).ok_or(ApiError::BadRequest(
        "username must look like name.42: 3-20 letters, digits or _, a dot and 2-4 digits",
    ))?;
    let identity_key = parse_identity_key(&req.identity_key)?;
    let caps = &state.limits;
    if let Some(ip) = ip {
        let key = format!("register-ip:{ip}");
        limits::take(
            db,
            &key,
            1,
            caps.registrations_per_ip_per_hour,
            limits::HOUR,
        )
        .await?;
    }
    limits::take(
        db,
        "register-all",
        1,
        caps.registrations_per_day,
        limits::DAY,
    )
    .await?;

    let mut tx = db.begin().await?;
    match (&req.invite, state.open_registration) {
        (Some(code), _) => invites::redeem(&mut tx, code).await?,
        (None, true) => {}
        (None, false) => return Err(ApiError::Forbidden("sign-up needs an invite")),
    }
    let created: Option<(Uuid,)> = sqlx::query_as(
        "INSERT INTO accounts (account_id, username) VALUES ($1, $2)
         ON CONFLICT (username) DO NOTHING RETURNING account_id",
    )
    .bind(Uuid::new_v4())
    .bind(&username)
    .fetch_optional(&mut *tx)
    .await?;
    let (account_id,) = created.ok_or(ApiError::Conflict("that username is taken"))?;
    let registered = create_device(&mut tx, account_id, username, identity_key).await?;
    tx.commit().await?;
    Ok(Json(registered))
}

pub fn parse_identity_key(raw: &str) -> Result<Vec<u8>, ApiError> {
    STANDARD
        .decode(raw)
        .ok()
        .filter(|k| (1..=256).contains(&k.len()))
        .ok_or(ApiError::BadRequest(
            "identity_key must be base64, at most 256 bytes",
        ))
}

/// Registers a new device for an account (phone verification or a device
/// link, ADR-0019); returns its id and bearer token.
pub async fn create_device(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    account_id: Uuid,
    username: String,
    identity_key: Vec<u8>,
) -> Result<Registered, ApiError> {
    // Serialise registrations per account so the limit holds.
    sqlx::query("SELECT 1 FROM accounts WHERE account_id = $1 FOR UPDATE")
        .bind(account_id)
        .execute(&mut **tx)
        .await?;
    let (devices,): (i64,) = sqlx::query_as("SELECT count(*) FROM devices WHERE account_id = $1")
        .bind(account_id)
        .fetch_one(&mut **tx)
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
    .execute(&mut **tx)
    .await?;
    Ok(Registered {
        account_id,
        device_id,
        token,
        username,
    })
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
    fn username_validation() {
        for (raw, ok) in [
            ("alex.27", "alex.27"),
            ("Alex_9.2025", "alex_9.2025"),
            (" bob.00 ", "bob.00"),
        ] {
            assert_eq!(normalize_username(raw).as_deref(), Some(ok), "{raw}");
        }
        for bad in [
            "alex",
            "al.27",
            "1alex.27",
            "alex.2",
            "alex.12345",
            "al-ex.27",
            "alex.2a",
            "a".repeat(21).as_str(),
        ] {
            assert_eq!(normalize_username(bad), None, "{bad}");
        }
    }
}

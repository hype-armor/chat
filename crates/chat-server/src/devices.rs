//! Linked devices (ADR-0019): one-time link codes, and listing and removing
//! an account's devices.

use std::collections::HashMap;

use axum::{Json, extract::State, http::StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, Registered, create_device, db, parse_identity_key},
    error::ApiError,
    limits::{self, ClientIp},
};

const LINK_TTL_MINUTES: i32 = 10;

fn link_hash(code: &str) -> Result<Vec<u8>, ApiError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(code)
        .ok()
        .filter(|b| b.len() == 16)
        .ok_or(ApiError::BadRequest("malformed link code"))?;
    Ok(Sha256::digest(bytes).to_vec())
}

#[derive(Serialize)]
pub struct LinkCode {
    /// 16 random bytes, base64url: shown by the new device as a QR code.
    code: String,
}

/// A new device asks for a link code to show.
pub async fn start(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
) -> Result<Json<LinkCode>, ApiError> {
    let db = db(&state)?;
    if let Some(ip) = ip {
        let limit = state.limits.links_per_ip_per_hour;
        limits::take(db, &format!("link-ip:{ip}"), 1, limit, limits::HOUR).await?;
    }
    let code = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>());
    sqlx::query(
        "INSERT INTO link_requests (code_hash, expires_at)
         VALUES ($1, now() + make_interval(mins => $2))",
    )
    .bind(link_hash(&code)?)
    .bind(LINK_TTL_MINUTES)
    .execute(db)
    .await?;
    Ok(Json(LinkCode { code }))
}

#[derive(Deserialize)]
pub struct Code {
    code: String,
}

/// A signed-in device approves a code: the new device joins its account.
pub async fn approve(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<Code>,
) -> Result<StatusCode, ApiError> {
    let db = db(&state)?;
    let row: Option<(Option<Uuid>,)> = sqlx::query_as(
        "SELECT account_id FROM link_requests WHERE code_hash = $1 AND expires_at > now()",
    )
    .bind(link_hash(&req.code)?)
    .fetch_optional(db)
    .await?;
    match row {
        None => Err(ApiError::NotFound("unknown or expired link code")),
        Some((Some(_),)) => Err(ApiError::Conflict("this code was already used")),
        Some((None,)) => {
            let updated = sqlx::query(
                "UPDATE link_requests
                 SET account_id = (SELECT account_id FROM devices WHERE device_id = $2)
                 WHERE code_hash = $1 AND account_id IS NULL",
            )
            .bind(link_hash(&req.code)?)
            .bind(device)
            .execute(db)
            .await?;
            if updated.rows_affected() == 0 {
                return Err(ApiError::Conflict("this code was already used"));
            }
            Ok(StatusCode::NO_CONTENT)
        }
    }
}

#[derive(Serialize)]
pub struct LinkStatus {
    /// The new device, once it has completed the link.
    device_id: Option<Uuid>,
}

/// The approving account polls until the new device has registered.
pub async fn status(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<Code>,
) -> Result<Json<LinkStatus>, ApiError> {
    let row: Option<(Option<Uuid>,)> = sqlx::query_as(
        "SELECT l.device_id FROM link_requests l
         JOIN devices d ON d.account_id = l.account_id
         WHERE l.code_hash = $1 AND d.device_id = $2",
    )
    .bind(link_hash(&req.code)?)
    .bind(device)
    .fetch_optional(db(&state)?)
    .await?;
    let (device_id,) = row.ok_or(ApiError::NotFound("unknown link code"))?;
    Ok(Json(LinkStatus { device_id }))
}

#[derive(Deserialize)]
pub struct Complete {
    code: String,
    /// Base64 identity public key of the new device.
    identity_key: String,
}

/// The new device polls with its code; once approved it is registered like
/// a phone verification (`409` until then).
pub async fn complete(
    State(state): State<AppState>,
    Json(req): Json<Complete>,
) -> Result<Json<Registered>, ApiError> {
    let identity_key = parse_identity_key(&req.identity_key)?;
    let hash = link_hash(&req.code)?;
    let mut tx = db(&state)?.begin().await?;
    let row: Option<(Option<Uuid>, Option<Uuid>, Option<String>)> = sqlx::query_as(
        "SELECT l.account_id, l.device_id, a.username FROM link_requests l
         LEFT JOIN accounts a USING (account_id)
         WHERE l.code_hash = $1 AND l.expires_at > now() FOR UPDATE OF l",
    )
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?;
    let (account_id, username) = match row {
        None | Some((_, Some(_), _)) => {
            return Err(ApiError::NotFound("unknown, expired or used link code"));
        }
        Some((None, _, _)) => return Err(ApiError::Conflict("waiting for approval")),
        Some((Some(account), None, username)) => (account, username.unwrap_or_default()),
    };
    let registered = create_device(&mut tx, account_id, username, identity_key).await?;
    sqlx::query("UPDATE link_requests SET device_id = $2 WHERE code_hash = $1")
        .bind(&hash)
        .bind(registered.device_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(registered))
}

#[derive(Serialize)]
pub struct DeviceInfo {
    device_id: Uuid,
    /// Day granularity, like `last_seen_day`.
    added_on: String,
    last_seen_on: Option<String>,
    current: bool,
}

#[derive(Serialize)]
pub struct DeviceList {
    devices: Vec<DeviceInfo>,
}

/// This account's devices, oldest first.
pub async fn list(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
) -> Result<Json<DeviceList>, ApiError> {
    let rows: Vec<(Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT d.device_id, d.created_at::date::text, d.last_seen_day::text
         FROM devices d JOIN devices me ON me.account_id = d.account_id
         WHERE me.device_id = $1 ORDER BY d.created_at, d.device_id",
    )
    .bind(device)
    .fetch_all(db(&state)?)
    .await?;
    let devices = rows
        .into_iter()
        .map(|(device_id, added_on, last_seen_on)| DeviceInfo {
            device_id,
            added_on,
            last_seen_on,
            current: device_id == device,
        })
        .collect();
    Ok(Json(DeviceList { devices }))
}

#[derive(Deserialize)]
pub struct Remove {
    device_id: Uuid,
}

/// Removes another device of this account: its token, queue, key packages
/// and memberships go with it. The remaining devices then commit its
/// removal from each group (ADR-0019).
pub async fn remove(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<Remove>,
) -> Result<StatusCode, ApiError> {
    if req.device_id == device {
        return Err(ApiError::BadRequest(
            "use another device to remove this one",
        ));
    }
    let deleted = sqlx::query(
        "DELETE FROM devices WHERE device_id = $1
         AND account_id = (SELECT account_id FROM devices WHERE device_id = $2)",
    )
    .bind(req.device_id)
    .bind(device)
    .execute(db(&state)?)
    .await?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError::NotFound("no such device on this account"));
    }
    state.hub.disconnect(&req.device_id);
    Ok(StatusCode::NO_CONTENT)
}

const MAX_ACCOUNTS: usize = 200;

#[derive(Deserialize)]
pub struct DevicesOf {
    account_ids: Vec<Uuid>,
}

#[derive(Serialize)]
pub struct AccountDevices {
    /// Account id → its devices, oldest first. Accounts that share no
    /// conversation with the caller (including deleted ones) are absent.
    devices: HashMap<Uuid, Vec<Uuid>>,
}

/// `POST /v1/devices/of`: other members' current devices, so clients can
/// keep every member's devices in their groups (ADR-0022).
pub async fn of(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<DevicesOf>,
) -> Result<Json<AccountDevices>, ApiError> {
    if req.account_ids.is_empty() || req.account_ids.len() > MAX_ACCOUNTS {
        return Err(ApiError::BadRequest("ask for 1 to 200 accounts"));
    }
    let db = db(&state)?;
    let key = format!("devices-of:{device}");
    limits::take(
        db,
        &key,
        1,
        state.limits.device_lists_per_hour,
        limits::HOUR,
    )
    .await?;
    // Only accounts sharing a conversation with the caller: no enumeration.
    let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT d.account_id, d.device_id FROM devices d
         WHERE d.account_id = ANY($1) AND EXISTS (
             SELECT 1 FROM conversation_members mine
             JOIN conversation_members theirs USING (conversation_id)
             JOIN devices td ON td.device_id = theirs.device_id
             WHERE mine.device_id = $2 AND td.account_id = d.account_id)
         ORDER BY d.created_at, d.device_id",
    )
    .bind(&req.account_ids)
    .bind(device)
    .fetch_all(db)
    .await?;
    let mut devices: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for (account, device) in rows {
        devices.entry(account).or_default().push(device);
    }
    Ok(Json(AccountDevices { devices }))
}

//! Invites for invite-only sign-up (ADR-0021). Codes are single-use and
//! stored only as hashes. Who invited whom is not kept: a row is deleted
//! when its invite is used.

use axum::{Json, extract::State};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, db},
    error::ApiError,
    limits,
};

const INVITE_TTL_DAYS: i32 = 7;
/// Unused invites an account may hold at once.
const MAX_OPEN_INVITES: i64 = 5;

fn invite_hash(code: &str) -> Result<Vec<u8>, ApiError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(code.trim())
        .ok()
        .filter(|b| b.len() == 16)
        .ok_or(ApiError::BadRequest("malformed invite code"))?;
    Ok(Sha256::digest(bytes).to_vec())
}

/// Stores a new invite; `created_by` is `None` for the operator's invites
/// (`chat-server create-invite`).
pub async fn create_invite(db: &PgPool, created_by: Option<Uuid>) -> Result<String, ApiError> {
    let code = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>());
    sqlx::query(
        "INSERT INTO invites (code_hash, created_by, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3))",
    )
    .bind(invite_hash(&code)?)
    .bind(created_by)
    .bind(INVITE_TTL_DAYS)
    .execute(db)
    .await?;
    Ok(code)
}

/// Uses up an invite inside the sign-up transaction.
pub async fn redeem(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    code: &str,
) -> Result<(), ApiError> {
    let used = sqlx::query("DELETE FROM invites WHERE code_hash = $1 AND expires_at > now()")
        .bind(invite_hash(code)?)
        .execute(&mut **tx)
        .await?;
    if used.rows_affected() == 0 {
        return Err(ApiError::Forbidden(
            "this invite is not valid: it was used, expired or mistyped",
        ));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Invite {
    /// 16 random bytes, base64url; shared as `https://<host>/#invite=<code>`.
    code: String,
    expires_in_days: i32,
}

/// `POST /v1/invites`: a signed-in user invites someone.
pub async fn create(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
) -> Result<Json<Invite>, ApiError> {
    let db = db(&state)?;
    let (account, open): (Uuid, i64) = sqlx::query_as(
        "SELECT d.account_id,
                (SELECT count(*) FROM invites i WHERE i.created_by = d.account_id AND i.expires_at > now())
         FROM devices d WHERE d.device_id = $1",
    )
    .bind(device)
    .fetch_one(db)
    .await?;
    if open >= MAX_OPEN_INVITES {
        return Err(ApiError::TooManyRequests(
            "you have 5 unused invites; wait until they are used or expire",
        ));
    }
    let key = format!("invite:{account}");
    limits::take(db, &key, 1, state.limits.invites_per_day, limits::DAY).await?;
    Ok(Json(Invite {
        code: create_invite(db, Some(account)).await?,
        expires_in_days: INVITE_TTL_DAYS,
    }))
}

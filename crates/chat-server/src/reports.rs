//! User reports (FR-ID-8). Messages are end-to-end encrypted, so a report
//! carries only what the reporter chooses to disclose. Verifiable message
//! franking (FR-SAF-1) comes later.

use axum::{Json, extract::State, http::StatusCode};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, db},
    error::ApiError,
    limits,
};

const MAX_EVIDENCE: usize = 20;
const MAX_TEXT: usize = 4_000;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Reason {
    Spam,
    Harassment,
    Other,
}

#[derive(Deserialize, serde::Serialize)]
pub struct Evidence {
    text: String,
    /// Sender's clock, milliseconds since the Unix epoch.
    sent_at_ms: u64,
}

#[derive(Deserialize)]
pub struct Report {
    account_id: Uuid,
    reason: Reason,
    #[serde(default)]
    messages: Vec<Evidence>,
}

pub async fn create(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<Report>,
) -> Result<StatusCode, ApiError> {
    if req.messages.len() > MAX_EVIDENCE
        || req
            .messages
            .iter()
            .any(|m| m.text.chars().count() > MAX_TEXT)
    {
        return Err(ApiError::BadRequest(
            "at most 20 messages of up to 4000 characters",
        ));
    }
    let db = db(&state)?;
    let key = format!("report:{device}");
    limits::take(db, &key, 1, state.limits.reports_per_day, limits::DAY).await?;
    let reason = match req.reason {
        Reason::Spam => "spam",
        Reason::Harassment => "harassment",
        Reason::Other => "other",
    };
    let inserted = sqlx::query(
        "INSERT INTO reports (reporter_device_id, reported_account_id, reason, evidence)
         SELECT $1, account_id, $3, $4 FROM accounts WHERE account_id = $2",
    )
    .bind(device)
    .bind(req.account_id)
    .bind(reason)
    .bind(sqlx::types::Json(&req.messages))
    .execute(db)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(ApiError::NotFound("no such account"));
    }
    tracing::info!(reason, "user report received");
    Ok(StatusCode::NO_CONTENT)
}

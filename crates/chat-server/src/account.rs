//! Account deletion (FR-ID-9): removes everything the server holds for an
//! account. Devices, tokens, queued envelopes, key packages, memberships,
//! links and reports about it go by cascade. Rate-limit windows naming its
//! devices expire within two days.

use axum::{Json, extract::State, http::StatusCode};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, db},
    error::ApiError,
};

#[derive(Deserialize)]
pub struct Delete {
    /// The account's phone number, typed again to confirm.
    phone: String,
}

pub async fn delete(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<Delete>,
) -> Result<StatusCode, ApiError> {
    let mut tx = db(&state)?.begin().await?;
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT a.account_id, a.phone_number FROM accounts a
         JOIN devices d USING (account_id) WHERE d.device_id = $1 FOR UPDATE OF a",
    )
    .bind(device)
    .fetch_optional(&mut *tx)
    .await?;
    let (account, phone) = row.ok_or(ApiError::Unauthorized("invalid token"))?;
    if req.phone.trim() != phone {
        return Err(ApiError::BadRequest(
            "that is not this account's phone number",
        ));
    }
    let devices: Vec<(Uuid,)> =
        sqlx::query_as("SELECT device_id FROM devices WHERE account_id = $1")
            .bind(account)
            .fetch_all(&mut *tx)
            .await?;
    sqlx::query("DELETE FROM accounts WHERE account_id = $1")
        .bind(account)
        .execute(&mut *tx)
        .await?;
    for table in ["verification_codes", "code_requests"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE phone_number = $1"))
            .bind(&phone)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    for (device,) in devices {
        state.hub.disconnect(&device);
    }
    tracing::info!("account deleted");
    Ok(StatusCode::NO_CONTENT)
}

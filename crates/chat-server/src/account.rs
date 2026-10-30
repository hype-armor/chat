//! Account deletion (FR-ID-9): removes everything the server holds for an
//! account. Devices, tokens, queued envelopes, key packages, memberships,
//! links, unused invites, reports about it and its backup go (the backup's
//! object explicitly, the rest by cascade); its username
//! becomes free. Rate-limit windows naming its devices expire within two
//! days.

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
    /// The account's username, typed again to confirm.
    username: String,
}

pub async fn delete(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<Delete>,
) -> Result<StatusCode, ApiError> {
    let mut tx = db(&state)?.begin().await?;
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT a.account_id, a.username FROM accounts a
         JOIN devices d USING (account_id) WHERE d.device_id = $1 FOR UPDATE OF a",
    )
    .bind(device)
    .fetch_optional(&mut *tx)
    .await?;
    let (account, username) = row.ok_or(ApiError::Unauthorized("invalid token"))?;
    if req.username.trim().to_ascii_lowercase() != username {
        return Err(ApiError::BadRequest("that is not this account's username"));
    }
    let devices: Vec<(Uuid,)> =
        sqlx::query_as("SELECT device_id FROM devices WHERE account_id = $1")
            .bind(account)
            .fetch_all(&mut *tx)
            .await?;
    let watchers = crate::devices::watchers(&mut tx, account).await?;
    let backup: Option<(Option<String>,)> =
        sqlx::query_as("SELECT object_key FROM backups WHERE account_id = $1")
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?;
    sqlx::query("DELETE FROM accounts WHERE account_id = $1")
        .bind(account)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // The backup row went by cascade; its object goes here.
    if let Some(store) = &state.blobs {
        crate::backup::forget(store, backup.and_then(|(k,)| k)).await;
    }
    for (device,) in devices {
        state.hub.disconnect(&device);
    }
    state.hub.devices_changed(&watchers);
    tracing::info!("account deleted");
    Ok(StatusCode::NO_CONTENT)
}

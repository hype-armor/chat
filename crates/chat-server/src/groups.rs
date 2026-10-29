//! Group state the delivery service keeps for commit ordering.

use axum::{Json, extract::State};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    auth::{AuthDevice, db},
    error::ApiError,
};

#[derive(Deserialize)]
pub struct EpochQuery {
    /// Base64 opaque conversation (MLS group) id.
    group_id: String,
}

#[derive(Serialize)]
pub struct Epoch {
    epoch: i64,
    /// Base64 SHA-256 of the last accepted commit's ciphertext.
    last_commit_hash: String,
}

/// Current epoch of a group, so a client that lost the server's answer to
/// its commit can tell whether the commit was accepted (docs/03 §5.3).
/// POST keeps the group id out of URLs and logs.
pub async fn epoch(
    State(state): State<AppState>,
    AuthDevice(_): AuthDevice,
    Json(req): Json<EpochQuery>,
) -> Result<Json<Epoch>, ApiError> {
    let db = db(&state)?;
    let group_id = STANDARD
        .decode(&req.group_id)
        .ok()
        .filter(|id| (1..=64).contains(&id.len()))
        .ok_or(ApiError::BadRequest(
            "group_id must be base64, 1 to 64 bytes",
        ))?;
    let row: Option<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT epoch, last_commit_hash FROM group_epochs WHERE group_id = $1")
            .bind(group_id)
            .fetch_optional(db)
            .await?;
    let (epoch, hash) = row.ok_or(ApiError::NotFound("no commits recorded for this group"))?;
    Ok(Json(Epoch {
        epoch,
        last_commit_hash: STANDARD.encode(hash),
    }))
}

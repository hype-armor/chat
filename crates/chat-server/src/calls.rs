//! Group calls through LiveKit (ADR-0006, ADR-0031): room tokens for the
//! devices of a conversation, and whether a call is still going.
//!
//! Media is SFrame-encrypted end to end by the clients (ADR-0030), so
//! LiveKit forwards frames it can't read. Room names are a hash of the
//! conversation and call ids, so LiveKit never sees conversation ids;
//! participants are named by device id, which LiveKit (our own
//! infrastructure) learns as the server already does.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{Json, extract::State};
use base64::{Engine, engine::general_purpose::STANDARD};
use jsonwebtoken::{EncodingKey, Header, encode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, db},
    error::ApiError,
};

/// How long a join token can be used to connect (the session outlives it).
const JOIN_TTL: Duration = Duration::from_secs(10 * 60);
const ADMIN_TTL: Duration = Duration::from_secs(60);

/// `CHAT_LIVEKIT_URL` (what clients connect to, `wss://…`),
/// `CHAT_LIVEKIT_API_URL` (server to LiveKit; default: the same with
/// `http(s)`), `CHAT_LIVEKIT_API_KEY` and `CHAT_LIVEKIT_API_SECRET`.
#[derive(Clone, Debug, Default)]
pub struct LiveKitConfig {
    pub url: Option<String>,
    pub api_url: Option<String>,
    pub api_key: String,
    pub api_secret: String,
}

impl LiveKitConfig {
    fn enabled(&self) -> Option<&str> {
        self.url
            .as_deref()
            .filter(|_| !self.api_key.is_empty() && !self.api_secret.is_empty())
    }

    fn api_url(&self) -> Option<String> {
        self.api_url.clone().or_else(|| {
            self.url
                .as_ref()
                .map(|u| u.replacen("ws", "http", 1).trim_end_matches('/').to_owned())
        })
    }

    fn token(&self, identity: &str, grant: VideoGrant, ttl: Duration) -> Result<String, ApiError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let claims = Claims {
            iss: &self.api_key,
            sub: identity,
            nbf: now.saturating_sub(10),
            exp: now + ttl.as_secs(),
            video: grant,
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(self.api_secret.as_bytes()),
        )
        .map_err(|e| ApiError::Internal(e.into()))
    }
}

/// LiveKit access token claims.
#[derive(Serialize, Deserialize, Debug)]
pub struct Claims<'a> {
    pub iss: &'a str,
    pub sub: &'a str,
    pub nbf: u64,
    pub exp: u64,
    pub video: VideoGrant,
}

#[derive(Serialize, Deserialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideoGrant {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub room_join: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub room_list: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_publish: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_subscribe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_publish_data: Option<bool>,
}

/// The LiveKit room of a call: hex SHA-256 over both ids, so LiveKit can't
/// tell which conversation it belongs to or link calls of one conversation.
pub fn room_name(conversation_id: &[u8], call_id: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b"chat call room\0");
    h.update((conversation_id.len() as u32).to_be_bytes());
    h.update(conversation_id);
    h.update(call_id);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize)]
pub struct CallRequest {
    /// Base64 conversation (MLS group) id.
    conversation_id: String,
    /// Base64, 16 bytes.
    call_id: String,
}

#[derive(Serialize)]
pub struct Join {
    url: String,
    token: String,
}

#[derive(Serialize)]
pub struct Status {
    /// People (devices) in the call now; 0 once it has ended.
    participants: u32,
}

/// The room of a call this device may join: a member of the conversation.
async fn room_for(state: &AppState, device: Uuid, req: &CallRequest) -> Result<String, ApiError> {
    let conversation = STANDARD
        .decode(&req.conversation_id)
        .ok()
        .filter(|id| (1..=64).contains(&id.len()))
        .ok_or(ApiError::BadRequest(
            "conversation_id must be base64, 1 to 64 bytes",
        ))?;
    let call = STANDARD
        .decode(&req.call_id)
        .ok()
        .filter(|id| id.len() == 16)
        .ok_or(ApiError::BadRequest("call_id must be 16 bytes, base64"))?;
    let member: Option<(i32,)> = sqlx::query_as(
        "SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND device_id = $2",
    )
    .bind(&conversation)
    .bind(device)
    .fetch_optional(db(state)?)
    .await?;
    if member.is_none() {
        return Err(ApiError::Forbidden("not a member of this conversation"));
    }
    Ok(room_name(&conversation, &call))
}

/// `POST /v1/calls/join`: a LiveKit URL and token for one call.
pub async fn join(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<CallRequest>,
) -> Result<Json<Join>, ApiError> {
    let url = state
        .livekit
        .enabled()
        .ok_or(ApiError::NotFound(
            "group calls are not set up on this server",
        ))?
        .to_owned();
    let room = room_for(&state, device, &req).await?;
    let grant = VideoGrant {
        room: Some(room),
        room_join: true,
        can_publish: Some(true),
        can_subscribe: Some(true),
        // Everything goes through MLS; nothing through LiveKit's data channel.
        can_publish_data: Some(false),
        ..VideoGrant::default()
    };
    let token = state
        .livekit
        .token(&device.simple().to_string(), grant, JOIN_TTL)?;
    Ok(Json(Join { url, token }))
}

/// `POST /v1/calls/status`: how many are in a call, from LiveKit.
pub async fn status(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(req): Json<CallRequest>,
) -> Result<Json<Status>, ApiError> {
    let livekit = &state.livekit;
    livekit.enabled().ok_or(ApiError::NotFound(
        "group calls are not set up on this server",
    ))?;
    let room = room_for(&state, device, &req).await?;
    let grant = VideoGrant {
        room_list: true,
        ..VideoGrant::default()
    };
    let token = livekit.token("chat-server", grant, ADMIN_TTL)?;
    let api = livekit.api_url().ok_or(ApiError::Unavailable)?;
    let res = state
        .http
        .post(format!("{api}/twirp/livekit.RoomService/ListRooms"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "names": [room] }))
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "LiveKit unreachable");
            ApiError::Unavailable
        })?;
    if !res.status().is_success() {
        tracing::warn!(status = %res.status(), "LiveKit refused ListRooms");
        return Err(ApiError::Unavailable);
    }
    let body: serde_json::Value = res.json().await.map_err(|_| ApiError::Unavailable)?;
    let participants = body["rooms"]
        .as_array()
        .and_then(|rooms| rooms.first())
        // Twirp JSON may use either field name style.
        .and_then(|r| {
            r["num_participants"]
                .as_u64()
                .or(r["numParticipants"].as_u64())
        })
        .unwrap_or(0) as u32;
    Ok(Json(Status { participants }))
}

#[cfg(test)]
mod tests {
    use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};

    use super::*;

    #[test]
    fn rooms_do_not_reveal_conversations() {
        let a = room_name(b"conversation", &[1; 16]);
        assert_eq!(a.len(), 64);
        assert!(!a.contains("636f6e76"));
        assert_ne!(a, room_name(b"conversation", &[2; 16]));
        assert_ne!(a, room_name(b"conversatio", &[b'n'; 17][..16]));
    }

    #[test]
    fn tokens_are_livekit_jwts() {
        let config = LiveKitConfig {
            url: Some("wss://rtc.example.com".into()),
            api_url: None,
            api_key: "key".into(),
            api_secret: "a-secret-of-at-least-32-characters!".into(),
        };
        assert_eq!(config.api_url().as_deref(), Some("https://rtc.example.com"));
        let grant = VideoGrant {
            room: Some("r".into()),
            room_join: true,
            can_publish_data: Some(false),
            ..VideoGrant::default()
        };
        let token = config.token("device", grant, JOIN_TTL).unwrap();
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&["key"]);
        let claims = decode::<serde_json::Value>(
            &token,
            &DecodingKey::from_secret(config.api_secret.as_bytes()),
            &validation,
        )
        .unwrap()
        .claims;
        assert_eq!(claims["sub"], "device");
        assert_eq!(
            claims["video"],
            serde_json::json!({ "room": "r", "roomJoin": true, "canPublishData": false })
        );
    }
}

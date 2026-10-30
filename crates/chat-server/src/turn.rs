//! ICE servers for calls (ADR-0028). TURN credentials follow coturn's REST
//! API scheme (`use-auth-secret`): the username is `expiry:label` and the
//! password is base64(HMAC-SHA1(secret, username)), so coturn checks them
//! without a database. The label is random, so the relay's logs can't be
//! tied to an account.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::{Json, extract::State};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, KeyInit, Mac};
use serde::Serialize;
use sha1::Sha1;

use crate::{AppState, auth::AuthDevice, error::ApiError};

/// How long TURN credentials work; a call that outlives them keeps its
/// allocation (coturn checks only when allocating and refreshing).
pub const CREDENTIAL_TTL_SECS: u64 = 12 * 3600;

#[derive(Clone, Debug, Default)]
pub struct TurnConfig {
    pub stun_urls: Vec<String>,
    pub turn_urls: Vec<String>,
    /// coturn `static-auth-secret`; `None` offers no TURN servers.
    pub secret: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IceServers {
    pub ice_servers: Vec<IceServer>,
    /// Seconds the credentials stay valid.
    pub ttl: u64,
}

impl TurnConfig {
    /// The servers to offer at `now` (Unix seconds), with `label` in the username.
    pub fn servers(&self, now: u64, label: &str) -> Vec<IceServer> {
        let mut servers = Vec::new();
        if !self.stun_urls.is_empty() {
            servers.push(IceServer {
                urls: self.stun_urls.clone(),
                username: None,
                credential: None,
            });
        }
        if let (Some(secret), false) = (&self.secret, self.turn_urls.is_empty()) {
            let username = format!("{}:{label}", now + CREDENTIAL_TTL_SECS);
            servers.push(IceServer {
                urls: self.turn_urls.clone(),
                credential: Some(credential(secret, &username)),
                username: Some(username),
            });
        }
        servers
    }
}

/// base64(HMAC-SHA1(secret, username)), as coturn computes it.
pub fn credential(secret: &str, username: &str) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key");
    mac.update(username.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

/// `GET /v1/turn`: ICE servers for a call, for signed-in devices only.
pub async fn credentials(
    State(state): State<AppState>,
    AuthDevice(_device): AuthDevice,
) -> Result<Json<IceServers>, ApiError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let label = hex(&rand::random::<[u8; 8]>());
    Ok(Json(IceServers {
        ice_servers: state.turn.servers(now, &label),
        ttl: CREDENTIAL_TTL_SECS,
    }))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_match_coturn() {
        // Computed with: printf %s '1700000000:test' |
        //   openssl dgst -sha1 -hmac secret -binary | base64
        assert_eq!(credential("secret", "1700000000:test"), EXPECTED);
    }

    const EXPECTED: &str = "Jek93IGytc6+tp2hiK0p/AkyVds=";

    #[test]
    fn offers_turn_only_with_a_secret() {
        let mut config = TurnConfig {
            stun_urls: vec!["stun:turn.example.org:3478".into()],
            turn_urls: vec!["turn:turn.example.org:3478".into()],
            secret: None,
        };
        assert_eq!(config.servers(100, "x").len(), 1);
        config.secret = Some("s".into());
        let servers = config.servers(100, "x");
        assert_eq!(servers.len(), 2);
        let username = servers[1].username.as_deref().unwrap();
        assert_eq!(username, format!("{}:x", 100 + CREDENTIAL_TTL_SECS));
        assert_eq!(
            servers[1].credential.as_deref(),
            Some(credential("s", username).as_str())
        );
    }
}

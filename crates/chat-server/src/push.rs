//! Web Push wake-ups for devices that aren't connected (FR-NOT-1/2).
//!
//! Pushes carry **no payload**: the service worker shows a generic
//! notification, so nothing about the message reaches the push service.
//! Requests are authenticated with VAPID (RFC 8292): an ES256 JWT signed
//! with the server's P-256 key.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{Json, extract::State, http::StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthDevice, db},
    error::ApiError,
};

/// At most one push per device in this window: one wake-up is enough to
/// make the app fetch everything queued.
const COALESCE: Duration = Duration::from_secs(30);
const JWT_LIFETIME_SECS: u64 = 12 * 3600;
const MAX_ENDPOINT_LEN: usize = 1024;

pub struct PushSender {
    key: SigningKey,
    public_key: String,
    subject: String,
    http: reqwest::Client,
    last_sent: Mutex<HashMap<Uuid, Instant>>,
    /// Tests use plain-HTTP push endpoints; real ones are always HTTPS.
    allow_http: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Sent,
    /// No subscription, or pushed recently.
    Skipped,
    /// The push service says the subscription is gone; it was deleted.
    Expired,
    Failed,
}

impl PushSender {
    /// `private_key`: base64url raw 32-byte P-256 scalar (`CHAT_VAPID_PRIVATE_KEY`).
    pub fn new(private_key: &[u8], subject: String, allow_http: bool) -> anyhow::Result<Self> {
        let key = SigningKey::from_slice(private_key)?;
        let public_key =
            URL_SAFE_NO_PAD.encode(key.verifying_key().to_sec1_point(false).as_bytes());
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            key,
            public_key,
            subject,
            http,
            last_sent: Mutex::default(),
            allow_http,
        })
    }

    /// A random key, for development: subscriptions break on restart.
    pub fn generate(subject: String, allow_http: bool) -> anyhow::Result<Self> {
        loop {
            // Rejection-sample: almost every 32-byte string is a valid scalar.
            if let Ok(sender) = Self::new(&rand::random::<[u8; 32]>(), subject.clone(), allow_http)
            {
                return Ok(sender);
            }
        }
    }

    /// A new key pair as base64url strings: (private, public).
    pub fn generate_key_pair() -> anyhow::Result<(String, String)> {
        let sender = Self::generate(String::new(), false)?;
        Ok((
            URL_SAFE_NO_PAD.encode(sender.key.to_bytes()),
            sender.public_key,
        ))
    }

    /// Uncompressed public key, base64url: the browser's `applicationServerKey`.
    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    fn vapid_jwt(&self, audience: &str, now: u64) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({ "aud": audience, "exp": now + JWT_LIFETIME_SECS, "sub": self.subject });
        let claims = URL_SAFE_NO_PAD.encode(claims.to_string());
        let signing_input = format!("{header}.{claims}");
        let signature: Signature = self.key.sign(signing_input.as_bytes());
        format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    /// Wakes `device` if it has a subscription and wasn't pushed recently.
    pub async fn notify(&self, db: &PgPool, device: Uuid) -> Outcome {
        {
            let mut last = self.last_sent.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            if last
                .get(&device)
                .is_some_and(|t| now.duration_since(*t) < COALESCE)
            {
                return Outcome::Skipped;
            }
            last.insert(device, now);
        }
        let subscription: Option<(Option<serde_json::Value>,)> =
            match sqlx::query_as("SELECT push_subscription FROM devices WHERE device_id = $1")
                .bind(device)
                .fetch_optional(db)
                .await
            {
                Ok(row) => row,
                Err(e) => {
                    tracing::warn!(error = %e, "loading push subscription failed");
                    return Outcome::Failed;
                }
            };
        let Some(endpoint) = subscription.and_then(|(s,)| s).and_then(|s| {
            s.get("endpoint")
                .and_then(|e| e.as_str())
                .map(str::to_owned)
        }) else {
            return Outcome::Skipped;
        };
        let Some(audience) = audience(&endpoint, self.allow_http) else {
            return Outcome::Failed;
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let authorization = format!(
            "vapid t={}, k={}",
            self.vapid_jwt(&audience, now),
            self.public_key
        );
        let response = self
            .http
            .post(&endpoint)
            .header("authorization", authorization)
            .header("ttl", "86400")
            .header("urgency", "high")
            .header("content-length", "0")
            .send()
            .await;
        match response.map(|r| r.status().as_u16()) {
            Ok(200..=299) => Outcome::Sent,
            Ok(404 | 410) => {
                let _ =
                    sqlx::query("UPDATE devices SET push_subscription = NULL WHERE device_id = $1")
                        .bind(device)
                        .execute(db)
                        .await;
                Outcome::Expired
            }
            Ok(status) => {
                tracing::warn!(status, "push service rejected a push");
                Outcome::Failed
            }
            Err(e) => {
                tracing::warn!(error = %e, "push request failed");
                Outcome::Failed
            }
        }
    }
}

/// The JWT audience: the push endpoint's origin.
fn audience(endpoint: &str, allow_http: bool) -> Option<String> {
    let (scheme, rest) = endpoint.split_once("://")?;
    if scheme != "https" && !(allow_http && scheme == "http") {
        return None;
    }
    let host = rest.split('/').next().filter(|h| !h.is_empty())?;
    Some(format!("{scheme}://{host}"))
}

// ---- HTTP API --------------------------------------------------------------

#[derive(Serialize)]
pub struct PublicKey {
    public_key: String,
}

pub async fn public_key(State(state): State<AppState>) -> Result<Json<PublicKey>, ApiError> {
    let push = state
        .push
        .as_ref()
        .ok_or(ApiError::NotFound("push notifications are not configured"))?;
    Ok(Json(PublicKey {
        public_key: push.public_key().to_owned(),
    }))
}

#[derive(Deserialize)]
pub struct Subscription {
    endpoint: String,
    keys: SubscriptionKeys,
}

#[derive(Deserialize, Serialize)]
pub struct SubscriptionKeys {
    p256dh: String,
    auth: String,
}

/// Stores the browser's `PushSubscription.toJSON()` for this device.
pub async fn subscribe(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
    Json(sub): Json<Subscription>,
) -> Result<StatusCode, ApiError> {
    let db = db(&state)?;
    let allow_http = state.push.as_ref().is_some_and(|p| p.allow_http);
    if sub.endpoint.len() > MAX_ENDPOINT_LEN || audience(&sub.endpoint, allow_http).is_none() {
        return Err(ApiError::BadRequest("endpoint must be an https URL"));
    }
    if sub.keys.p256dh.len() > 256 || sub.keys.auth.len() > 64 {
        return Err(ApiError::BadRequest("subscription keys too long"));
    }
    let value = serde_json::json!({ "endpoint": sub.endpoint, "keys": sub.keys });
    sqlx::query("UPDATE devices SET push_subscription = $2 WHERE device_id = $1")
        .bind(device)
        .bind(value)
        .execute(db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn unsubscribe(
    State(state): State<AppState>,
    AuthDevice(device): AuthDevice,
) -> Result<StatusCode, ApiError> {
    sqlx::query("UPDATE devices SET push_subscription = NULL WHERE device_id = $1")
        .bind(device)
        .execute(db(&state)?)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use p256::ecdsa::{VerifyingKey, signature::Verifier};

    use super::*;

    #[test]
    fn vapid_jwt_verifies_with_the_public_key() {
        let sender = PushSender::generate("mailto:ops@example.com".into(), false).unwrap();
        let jwt = sender.vapid_jwt("https://push.example.com", 1_000);
        let (signing_input, signature) = jwt.rsplit_once('.').unwrap();
        let public =
            VerifyingKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(sender.public_key()).unwrap())
                .unwrap();
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).unwrap()).unwrap();
        public.verify(signing_input.as_bytes(), &signature).unwrap();

        let claims = signing_input.split('.').nth(1).unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://push.example.com");
        assert_eq!(claims["exp"], 1_000 + JWT_LIFETIME_SECS);
        assert_eq!(claims["sub"], "mailto:ops@example.com");
        assert_eq!(
            URL_SAFE_NO_PAD.decode(sender.public_key()).unwrap().len(),
            65
        );
    }

    #[test]
    fn generated_key_pairs_round_trip() {
        let (private, public) = PushSender::generate_key_pair().unwrap();
        let sender =
            PushSender::new(&URL_SAFE_NO_PAD.decode(private).unwrap(), "s".into(), false).unwrap();
        assert_eq!(sender.public_key(), public);
    }

    #[test]
    fn audience_is_the_endpoint_origin() {
        assert_eq!(
            audience("https://fcm.googleapis.com/fcm/send/abc", false).as_deref(),
            Some("https://fcm.googleapis.com")
        );
        assert_eq!(audience("http://127.0.0.1:9/x", false), None);
        assert_eq!(
            audience("http://127.0.0.1:9/x", true).as_deref(),
            Some("http://127.0.0.1:9")
        );
        assert_eq!(audience("not a url", true), None);
    }
}

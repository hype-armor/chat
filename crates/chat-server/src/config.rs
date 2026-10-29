use std::net::SocketAddr;

/// Server configuration, read from environment variables so the same image
/// runs under Docker Compose and Kubernetes.
#[derive(Clone, Debug)]
pub struct Config {
    /// `CHAT_BIND`, default `0.0.0.0:8080`.
    pub bind: SocketAddr,
    /// `DATABASE_URL`. Optional so the server can start for local UI work.
    pub database_url: Option<String>,
    /// `CHAT_LOG_FORMAT`: `json` (default, for clusters) or `pretty`.
    pub json_logs: bool,
    /// `CHAT_VAPID_PRIVATE_KEY`: base64url P-256 key for Web Push. Unset:
    /// a random key is generated (development only).
    pub vapid_private_key: Option<String>,
    /// `CHAT_VAPID_SUBJECT`: contact for push services, e.g. `mailto:ops@example.com`.
    pub vapid_subject: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let bind = std::env::var("CHAT_BIND")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_owned())
            .parse()?;
        let database_url = std::env::var("DATABASE_URL").ok().filter(|s| !s.is_empty());
        let json_logs = std::env::var("CHAT_LOG_FORMAT").map_or(true, |f| f != "pretty");
        Ok(Self {
            bind,
            database_url,
            json_logs,
            vapid_private_key: std::env::var("CHAT_VAPID_PRIVATE_KEY")
                .ok()
                .filter(|s| !s.is_empty()),
            vapid_subject: std::env::var("CHAT_VAPID_SUBJECT")
                .unwrap_or_else(|_| "mailto:admin@localhost".to_owned()),
        })
    }
}

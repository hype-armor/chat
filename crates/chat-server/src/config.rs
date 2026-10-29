use std::net::SocketAddr;

use crate::limits::Limits;

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
    /// Abuse limits. `CHAT_TRUST_PROXY_HEADERS=true` behind an ingress takes
    /// the client IP from `X-Forwarded-For`; each number can be overridden
    /// with `CHAT_LIMIT_<FIELD>`, e.g. `CHAT_LIMIT_CODES_PER_IP_PER_HOUR`.
    pub limits: Limits,
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
            limits: limits_from_env()?,
            vapid_subject: std::env::var("CHAT_VAPID_SUBJECT")
                .unwrap_or_else(|_| "mailto:admin@localhost".to_owned()),
        })
    }
}

fn limits_from_env() -> anyhow::Result<Limits> {
    let d = Limits::default();
    Ok(Limits {
        lookups_per_hour: limit_var("LOOKUPS_PER_HOUR", d.lookups_per_hour)?,
        claims_per_hour: limit_var("CLAIMS_PER_HOUR", d.claims_per_hour)?,
        welcomes_per_day: limit_var("WELCOMES_PER_DAY", d.welcomes_per_day)?,
        sends_per_minute: limit_var("SENDS_PER_MINUTE", d.sends_per_minute)?,
        codes_per_ip_per_hour: limit_var("CODES_PER_IP_PER_HOUR", d.codes_per_ip_per_hour)?,
        codes_per_prefix_per_hour: limit_var(
            "CODES_PER_PREFIX_PER_HOUR",
            d.codes_per_prefix_per_hour,
        )?,
        codes_per_day: limit_var("CODES_PER_DAY", d.codes_per_day)?,
        trust_proxy_headers: std::env::var("CHAT_TRUST_PROXY_HEADERS").is_ok_and(|v| v == "true"),
    })
}

fn limit_var<T: std::str::FromStr>(name: &str, default: T) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    let key = format!("CHAT_LIMIT_{name}");
    match std::env::var(&key) {
        Ok(v) => v.parse().map_err(|e| anyhow::anyhow!("{key}={v}: {e}")),
        Err(_) => Ok(default),
    }
}

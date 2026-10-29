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
    /// `CHAT_METRICS_BIND`, default `0.0.0.0:9090`; empty disables the
    /// Prometheus endpoint. Not routed by the ingress.
    pub metrics_bind: Option<SocketAddr>,
    /// Abuse limits. `CHAT_TRUST_PROXY_HEADERS=true` behind an ingress takes
    /// the client IP from `X-Forwarded-For`; each number can be overridden
    /// with `CHAT_LIMIT_<FIELD>`, e.g. `CHAT_LIMIT_REGISTRATIONS_PER_IP_PER_HOUR`.
    pub limits: Limits,
    /// `CHAT_REGISTRATION`: `invite` (default) or `open` (development and
    /// tests): whether sign-up needs an invite (ADR-0021).
    pub open_registration: bool,
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
            metrics_bind: match std::env::var("CHAT_METRICS_BIND") {
                Ok(v) if v.is_empty() => None,
                Ok(v) => Some(v.parse()?),
                Err(_) => Some(SocketAddr::from(([0, 0, 0, 0], 9090))),
            },
            limits: limits_from_env()?,
            open_registration: match std::env::var("CHAT_REGISTRATION").as_deref() {
                Ok("open") => true,
                Ok("invite") | Err(_) => false,
                Ok(other) => anyhow::bail!("CHAT_REGISTRATION must be open or invite, not {other}"),
            },
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
        registrations_per_ip_per_hour: limit_var(
            "REGISTRATIONS_PER_IP_PER_HOUR",
            d.registrations_per_ip_per_hour,
        )?,
        registrations_per_day: limit_var("REGISTRATIONS_PER_DAY", d.registrations_per_day)?,
        invites_per_day: limit_var("INVITES_PER_DAY", d.invites_per_day)?,
        links_per_ip_per_hour: limit_var("LINKS_PER_IP_PER_HOUR", d.links_per_ip_per_hour)?,
        reports_per_day: limit_var("REPORTS_PER_DAY", d.reports_per_day)?,
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

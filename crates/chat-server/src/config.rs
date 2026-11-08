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
    /// `CHAT_PUSH_HOSTS`: push service hosts the server may send to
    /// (comma separated; empty keeps the browser vendors' defaults).
    pub push_hosts: Vec<String>,
    /// `CHAT_METRICS_BIND`, default `0.0.0.0:9090`; empty disables the
    /// Prometheus endpoint. Not routed by the ingress.
    pub metrics_bind: Option<SocketAddr>,
    /// Abuse limits. `CHAT_TRUST_PROXY_HEADERS=true` behind an ingress takes
    /// the client IP from `X-Forwarded-For`; each number can be overridden
    /// with `CHAT_LIMIT_<FIELD>`, e.g. `CHAT_LIMIT_REGISTRATIONS_PER_IP_PER_HOUR`.
    /// Negative values are invalid. Zero retains each limiter's semantics:
    /// account sends are blocked; WebSocket auth-failure throttling is disabled.
    /// `CHAT_LIMIT_BLOB_MB_PER_ACCOUNT` is obsolete and prevents startup.
    /// Use `chat-admin storage default <bytes>` for persistent storage policy.
    pub limits: Limits,
    /// `CHAT_BLOB_STORE`: where encrypted attachments go (ADR-0023):
    /// `s3://bucket` (with `AWS_*` variables), `file:///path` or `memory`
    /// (default, development only: lost on restart).
    pub blob_store: String,
    /// `CHAT_REGISTRATION`: `invite` (default) or `open` (development and
    /// tests): whether sign-up needs an invite (ADR-0021).
    pub open_registration: bool,
    /// Calls (ADR-0028): `CHAT_STUN_URLS` and `CHAT_TURN_URLS`, comma
    /// separated (`stun:host:3478`, `turn:host:3478?transport=udp`,
    /// `turns:host:5349`), and `CHAT_TURN_SECRET`, coturn's
    /// `static-auth-secret`. Without a secret no TURN servers are offered.
    pub turn: crate::turn::TurnConfig,
    /// Group calls (ADR-0031): see [`crate::calls::LiveKitConfig`].
    pub livekit: crate::calls::LiveKitConfig,
    /// Map areas on demand (ADR-0033): see [`crate::tiles::TilesConfig`].
    pub tiles: crate::tiles::TilesConfig,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        reject_legacy_storage_limit(std::env::var_os("CHAT_LIMIT_BLOB_MB_PER_ACCOUNT").as_deref())?;
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
            blob_store: std::env::var("CHAT_BLOB_STORE").unwrap_or_else(|_| "memory".to_owned()),
            open_registration: match std::env::var("CHAT_REGISTRATION").as_deref() {
                Ok("open") => true,
                Ok("invite") | Err(_) => false,
                Ok(other) => anyhow::bail!("CHAT_REGISTRATION must be open or invite, not {other}"),
            },
            turn: crate::turn::TurnConfig {
                stun_urls: list_var("CHAT_STUN_URLS"),
                turn_urls: list_var("CHAT_TURN_URLS"),
                secret: std::env::var("CHAT_TURN_SECRET")
                    .ok()
                    .filter(|s| !s.is_empty()),
            },
            livekit: crate::calls::LiveKitConfig {
                url: non_empty("CHAT_LIVEKIT_URL"),
                api_url: non_empty("CHAT_LIVEKIT_API_URL"),
                api_key: non_empty("CHAT_LIVEKIT_API_KEY").unwrap_or_default(),
                api_secret: non_empty("CHAT_LIVEKIT_API_SECRET").unwrap_or_default(),
            },
            tiles: crate::tiles::TilesConfig {
                dir: non_empty("CHAT_TILES_DIR").map(Into::into),
                source: non_empty("CHAT_TILES_SOURCE"),
                max_regions: limit_var("TILES_MAX_REGIONS", 500)?,
            },
            vapid_subject: std::env::var("CHAT_VAPID_SUBJECT")
                .unwrap_or_else(|_| "mailto:admin@localhost".to_owned()),
            push_hosts: list_var("CHAT_PUSH_HOSTS"),
        })
    }
}

/// Any old setting must fail, including zero, empty, and non-Unicode values.
/// Silently ignoring it could weaken an operator's existing storage policy.
fn reject_legacy_storage_limit(value: Option<&std::ffi::OsStr>) -> anyhow::Result<()> {
    if value.is_some() {
        anyhow::bail!(
            "CHAT_LIMIT_BLOB_MB_PER_ACCOUNT is obsolete and is not enforced; \
             set the account storage policy with `chat-admin storage default <bytes>`, \
             then unset CHAT_LIMIT_BLOB_MB_PER_ACCOUNT before starting the server"
        );
    }
    Ok(())
}

fn limits_from_env() -> anyhow::Result<Limits> {
    let d = Limits::default();
    Ok(Limits {
        lookups_per_hour: limit_var("LOOKUPS_PER_HOUR", d.lookups_per_hour)?,
        claims_per_hour: limit_var("CLAIMS_PER_HOUR", d.claims_per_hour)?,
        welcomes_per_day: limit_var("WELCOMES_PER_DAY", d.welcomes_per_day)?,
        sends_per_minute: limit_var("SENDS_PER_MINUTE", d.sends_per_minute)?,
        sends_per_account_per_minute: limit_var(
            "SENDS_PER_ACCOUNT_PER_MINUTE",
            d.sends_per_account_per_minute,
        )?,
        ws_auth_failures_per_minute: limit_var(
            "WS_AUTH_FAILURES_PER_MINUTE",
            d.ws_auth_failures_per_minute,
        )?,
        registrations_per_ip_per_hour: limit_var(
            "REGISTRATIONS_PER_IP_PER_HOUR",
            d.registrations_per_ip_per_hour,
        )?,
        registrations_per_day: limit_var("REGISTRATIONS_PER_DAY", d.registrations_per_day)?,
        invites_per_day: limit_var("INVITES_PER_DAY", d.invites_per_day)?,
        links_per_ip_per_hour: limit_var("LINKS_PER_IP_PER_HOUR", d.links_per_ip_per_hour)?,
        reports_per_day: limit_var("REPORTS_PER_DAY", d.reports_per_day)?,
        device_lists_per_hour: limit_var("DEVICE_LISTS_PER_HOUR", d.device_lists_per_hour)?,
        blob_mb_per_day: limit_var("BLOB_MB_PER_DAY", d.blob_mb_per_day)?,
        restores_per_ip_per_hour: limit_var(
            "RESTORES_PER_IP_PER_HOUR",
            d.restores_per_ip_per_hour,
        )?,
        restores_per_account_per_day: limit_var(
            "RESTORES_PER_ACCOUNT_PER_DAY",
            d.restores_per_account_per_day,
        )?,
        restore_failures_per_day: limit_var(
            "RESTORE_FAILURES_PER_DAY",
            d.restore_failures_per_day,
        )?,
        send_mb_per_day: limit_var("SEND_MB_PER_DAY", d.send_mb_per_day)?,
        queue_rows_per_device: limit_var("QUEUE_ROWS_PER_DEVICE", d.queue_rows_per_device)?,
        // Compatibility field only. Persistent storage policy replaces it.
        blob_mb_per_account: d.blob_mb_per_account,
        turn_credentials_per_day: limit_var(
            "TURN_CREDENTIALS_PER_DAY",
            d.turn_credentials_per_day,
        )?,
        tile_areas_per_hour: limit_var("TILE_AREAS_PER_HOUR", d.tile_areas_per_hour)?,
        tile_reads_per_minute: limit_var("TILE_READS_PER_MINUTE", d.tile_reads_per_minute)?,
        trust_proxy_headers: std::env::var("CHAT_TRUST_PROXY_HEADERS").is_ok_and(|v| v == "true"),
    })
}

fn limit_var<T>(name: &str, default: T) -> anyhow::Result<T>
where
    T: std::str::FromStr + PartialOrd + Default,
    T::Err: std::fmt::Display,
{
    let key = format!("CHAT_LIMIT_{name}");
    match std::env::var(&key) {
        Ok(v) => parse_limit(&key, &v),
        Err(_) => Ok(default),
    }
}

fn parse_limit<T>(key: &str, value: &str) -> anyhow::Result<T>
where
    T: std::str::FromStr + PartialOrd + Default,
    T::Err: std::fmt::Display,
{
    let parsed: T = value
        .parse()
        .map_err(|e| anyhow::anyhow!("{key}={value}: {e}"))?;
    if parsed < T::default() {
        anyhow::bail!("{key}={value}: limit must be zero or greater");
    }
    Ok(parsed)
}

fn list_var(name: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn non_empty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{parse_limit, reject_legacy_storage_limit};

    #[test]
    fn obsolete_storage_limit_fails_startup_for_every_set_value() {
        assert!(reject_legacy_storage_limit(None).is_ok());
        for value in ["2048", "1", "0", "-1", "", "not-a-number"] {
            let error = reject_legacy_storage_limit(Some(std::ffi::OsStr::new(value)))
                .unwrap_err()
                .to_string();
            assert!(error.contains("CHAT_LIMIT_BLOB_MB_PER_ACCOUNT"));
            assert!(error.contains("chat-admin storage default <bytes>"));
            assert!(error.contains("then unset CHAT_LIMIT_BLOB_MB_PER_ACCOUNT"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn obsolete_storage_limit_rejects_non_unicode_values() {
        use std::os::unix::ffi::OsStrExt;
        assert!(reject_legacy_storage_limit(Some(std::ffi::OsStr::from_bytes(&[0xff]))).is_err());
    }

    #[test]
    fn signed_limits_reject_negative_values_and_keep_zero() {
        let key = "CHAT_LIMIT_SENDS_PER_ACCOUNT_PER_MINUTE";
        let error = parse_limit::<i32>(key, "-1").unwrap_err();
        assert!(error.to_string().contains(key));
        assert!(error.to_string().contains("zero or greater"));
        assert!(parse_limit::<i64>("CHAT_LIMIT_QUEUE_ROWS_PER_DEVICE", "-1").is_err());
        assert_eq!(parse_limit::<i32>(key, "0").unwrap(), 0);
        assert_eq!(parse_limit::<i32>(key, "600").unwrap(), 600);
    }

    #[test]
    fn unsigned_and_malformed_limits_keep_parse_validation() {
        let key = "CHAT_LIMIT_SENDS_PER_MINUTE";
        assert!(parse_limit::<u32>(key, "-1").is_err());
        assert!(parse_limit::<i32>(key, "2147483648").is_err());
        assert!(parse_limit::<i32>(key, "not-a-number").is_err());
        assert_eq!(parse_limit::<u32>(key, "0").unwrap(), 0);
    }
}

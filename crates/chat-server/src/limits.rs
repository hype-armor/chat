//! Abuse limits (FR-SAF-2, NFR-LEG-5).
//!
//! Low-volume actions (lookups, key claims, first contacts, verification
//! codes) use fixed-window counters in PostgreSQL so every replica sees the
//! same counts. Message sends use an in-memory token bucket per device: they
//! are frequent, and per-replica limits are good enough for them.

use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::request::Parts,
};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{AppState, error::ApiError};

#[derive(Clone, Debug)]
pub struct Limits {
    pub lookups_per_hour: i32,
    pub claims_per_hour: i32,
    /// Devices a device may welcome (first contact) per day.
    pub welcomes_per_day: i32,
    pub sends_per_minute: u32,
    /// Failed sign-in attempts on `/v1/ws` per client IP per minute.
    pub ws_auth_failures_per_minute: u32,
    /// Sign-ups per client IP per hour (ADR-0021).
    pub registrations_per_ip_per_hour: i32,
    /// Sign-ups across the whole service per day.
    pub registrations_per_day: i32,
    /// Invites an account may create per day.
    pub invites_per_day: i32,
    /// Device link codes per client IP per hour (ADR-0019).
    pub links_per_ip_per_hour: i32,
    /// Attachment megabytes a device may upload per day (ADR-0023).
    pub blob_mb_per_day: i32,
    /// Restore attempts per client IP per hour and per account per day.
    pub restores_per_ip_per_hour: i32,
    pub restores_per_account_per_day: i32,
    /// Wrong recovery secrets per account per day, before recovery locks.
    pub restore_failures_per_day: i32,
    /// Envelope bytes a device may store per day (queue flooding: a sender
    /// must not be able to fill a recipient's queue).
    pub send_mb_per_day: i32,
    /// Queued envelopes kept per recipient device; the oldest go first.
    pub queue_rows_per_device: i64,
    /// Bytes an account may keep in the attachment store at once.
    pub blob_mb_per_account: i32,
    /// TURN credential requests per device per day (relay abuse).
    pub turn_credentials_per_day: i32,
    /// Map areas one device may ask the server to download per hour.
    pub tile_areas_per_hour: i32,
    /// Tile requests per device per minute.
    pub tile_reads_per_minute: u32,
    /// Member device-list checks per device per hour (ADR-0022).
    pub device_lists_per_hour: i32,
    /// User reports per device per day (FR-ID-8).
    pub reports_per_day: i32,
    /// Trust `X-Forwarded-For` from the ingress for the client IP.
    pub trust_proxy_headers: bool,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            lookups_per_hour: 30,
            claims_per_hour: 300,
            welcomes_per_day: 200,
            sends_per_minute: 600,
            ws_auth_failures_per_minute: 30,
            registrations_per_ip_per_hour: 10,
            registrations_per_day: 1_000,
            invites_per_day: 10,
            links_per_ip_per_hour: 20,
            reports_per_day: 20,
            device_lists_per_hour: 120,
            restores_per_ip_per_hour: 10,
            blob_mb_per_day: 2_048,
            restores_per_account_per_day: 10,
            restore_failures_per_day: 100,
            send_mb_per_day: 100,
            queue_rows_per_device: 1_000,
            blob_mb_per_account: 2_048,
            turn_credentials_per_day: 20,
            tile_areas_per_hour: 5,
            tile_reads_per_minute: 300,
            trust_proxy_headers: false,
        }
    }
}

/// Adds `amount` to the counter for `key` in the current window; refuses if
/// that would exceed `limit`. The counter only grows when allowed.
pub async fn take(
    db: &PgPool,
    key: &str,
    amount: i32,
    limit: i32,
    window_secs: i64,
) -> Result<(), ApiError> {
    take_on(db, key, amount, limit, window_secs).await
}

/// Same as [`take`], inside a transaction: a request that fails later rolls
/// its counter back too, so unauthenticated work cannot spend a victim's
/// (or the service's) budget.
pub async fn tx_take(
    tx: &mut Transaction<'_, Postgres>,
    key: &str,
    amount: i32,
    limit: i32,
    window_secs: i64,
) -> Result<(), ApiError> {
    take_on(&mut **tx, key, amount, limit, window_secs).await
}

async fn take_on<'e, E>(
    exec: E,
    key: &str,
    amount: i32,
    limit: i32,
    window_secs: i64,
) -> Result<(), ApiError>
where
    E: sqlx::PgExecutor<'e>,
{
    let refused = || ApiError::TooManyRequests("rate limit reached; try again later");
    // Checked up front: the insert path below has no WHERE clause, so an
    // oversized first request would otherwise use up the whole window.
    if amount > limit {
        return Err(refused());
    }
    let allowed: Option<(i32,)> = sqlx::query_as(
        "INSERT INTO rate_limits (key, window_start, count)
         VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $4) * $4), $2)
         ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + $2
         WHERE rate_limits.count + $2 <= $3
         RETURNING count",
    )
    .bind(key)
    .bind(amount)
    .bind(limit)
    .bind(window_secs as f64)
    .fetch_optional(exec)
    .await?;
    allowed.map(|_| ()).ok_or_else(refused)
}

pub const HOUR: i64 = 3600;
pub const DAY: i64 = 86_400;

/// Failed WebSocket sign-ins per client IP: fixed windows, kept in memory
/// on each replica. Device tokens are long random values, so guessing one
/// is not the threat; this only stops one address from hammering the
/// database lookup behind every `Authenticate` frame, for which per-replica
/// counts are good enough (as for sends).
pub struct FailureBuckets {
    /// Length of every window.
    window: Duration,
    windows: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl FailureBuckets {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Whether this client may still try to authenticate. An unknown IP is
    /// never limited (there is nothing to key on) and `limit` 0 means
    /// unlimited. Expired windows go while the lock is held.
    pub fn allow(&self, ip: &Option<IpAddr>, limit: u32) -> bool {
        let Some(ip) = *ip else {
            return true;
        };
        if limit == 0 {
            return true;
        }
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        prune(&mut windows, now, self.window);
        // Only live windows survive the prune, so an entry is this IP's
        // count in the current window.
        windows
            .get(&ip)
            .is_none_or(|(count, _start)| *count < limit)
    }

    /// Counts one failed attempt in this IP's current window, opening a new
    /// window when the old one has passed.
    pub fn record(&self, ip: Option<IpAddr>) {
        let Some(ip) = ip else { return };
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        prune(&mut windows, now, self.window);
        match windows.get_mut(&ip) {
            Some(entry) if now < entry.1 + self.window => entry.0 += 1,
            _ => {
                windows.insert(ip, (1, now));
            }
        }
    }
}

/// Drop the entries whose window has passed.
fn prune(windows: &mut HashMap<IpAddr, (u32, Instant)>, now: Instant, window: Duration) {
    windows.retain(|_, (_, start)| now < *start + window);
}

/// Per-device token buckets for message sends.
#[derive(Default)]
pub struct SendBuckets {
    buckets: Mutex<HashMap<Uuid, (f64, Instant)>>,
}

impl SendBuckets {
    pub fn allow(&self, device: Uuid, per_minute: u32) -> bool {
        let capacity = f64::from(per_minute);
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let (tokens, last) = buckets.entry(device).or_insert((capacity, now));
        *tokens =
            (*tokens + now.duration_since(*last).as_secs_f64() * capacity / 60.0).min(capacity);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// The caller's IP: from `X-Forwarded-For` when the ingress is trusted,
/// else the socket peer; `None` if neither is known. Only the last entry is
/// used: it is the one our ingress appended, while earlier ones come from
/// the client and can be forged.
pub struct ClientIp(pub Option<IpAddr>);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if state.limits.trust_proxy_headers
            && let Some(ip) = parts
                .headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit(',').next())
                .and_then(|v| v.trim().parse().ok())
        {
            return Ok(Self(Some(ip)));
        }
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip());
        Ok(Self(peer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_bucket_allows_a_burst_then_refills() {
        let buckets = SendBuckets::default();
        let device = Uuid::new_v4();
        assert!((0..3).all(|_| buckets.allow(device, 3)));
        assert!(!buckets.allow(device, 3));
        assert!(buckets.allow(Uuid::new_v4(), 3), "per device");
    }

    #[test]
    fn failure_buckets_block_an_ip_that_hits_its_limit_then_clear() {
        let window = Duration::from_millis(50);
        let buckets = FailureBuckets::new(window);
        let ip = IpAddr::from([1, 2, 3, 4]);
        let other = IpAddr::from([5, 6, 7, 8]);
        assert!(buckets.allow(&Some(ip), 2), "no window yet");
        buckets.record(Some(ip));
        buckets.record(Some(ip));
        assert!(!buckets.allow(&Some(ip), 2), "limit reached");
        assert!(buckets.allow(&Some(other), 2), "per ip");
        assert!(buckets.allow(&None, 2), "unknown ip");
        std::thread::sleep(window * 2);
        assert!(buckets.allow(&Some(ip), 2), "window expired");
    }
}

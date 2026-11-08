//! Abuse limits (FR-SAF-2, NFR-LEG-5).
//!
//! Fixed-window counters in PostgreSQL share budgets across replicas for
//! lookups, key claims, first contacts, verification codes and account sends.
//! Message sends also use an in-memory token bucket per device to bound bursts.

use std::{
    collections::{HashMap, VecDeque},
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
    /// Accepted send requests per account per minute, shared by all replicas.
    /// Zero blocks sends. An account_send_limits row overrides this default.
    pub sends_per_account_per_minute: i32,
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
    /// Deprecated compatibility field, in MiB. Storage enforcement does not read it.
    /// Persistent storage policy replaces this field (ADR-0040).
    /// Setting CHAT_LIMIT_BLOB_MB_PER_ACCOUNT now prevents server startup.
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
            sends_per_account_per_minute: 600,
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
    // Checked up front: the insert path below has no WHERE clause. These
    // bounds also make limit - amount safe, even at i32::MAX.
    if amount < 0 || amount > limit {
        return Err(refused());
    }
    let allowed: Option<(i32,)> = sqlx::query_as(
        "INSERT INTO rate_limits (key, window_start, count)
         VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $4) * $4), $2)
         ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + $2
         WHERE rate_limits.count <= $3 - $2
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

pub const MINUTE: i64 = 60;
pub const HOUR: i64 = 3600;
pub const DAY: i64 = 86_400;

/// Failed WebSocket sign-ins per client IP: fixed windows, kept in memory
/// on each replica. Device tokens are long random values, so guessing one
/// is not the threat; this only stops one address from hammering the
/// database lookup behind every `Authenticate` frame, for which per-replica
/// counts are good enough.
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
    state: Mutex<SendBucketState>,
}

#[derive(Default)]
struct SendBucketState {
    buckets: HashMap<Uuid, (f64, Instant)>,
    cleanup: VecDeque<Uuid>,
}

impl SendBuckets {
    pub fn allow(&self, device: Uuid, per_minute: u32) -> bool {
        self.allow_with_clock(device, per_minute, Instant::now)
    }

    fn allow_with_clock(
        &self,
        device: Uuid,
        per_minute: u32,
        clock: impl FnOnce() -> Instant,
    ) -> bool {
        let capacity = f64::from(per_minute);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let now = clock();
        // A bucket is full after 60 idle seconds, so removing it does not
        // grant extra tokens. Scan at most 64 entries per request, with a
        // rotating cursor, rather than scanning every device under the lock.
        for _ in 0..state.cleanup.len().min(64) {
            let id = state.cleanup.pop_front().expect("cleanup entry");
            if now.duration_since(state.buckets[&id].1) >= Duration::from_secs(60) {
                state.buckets.remove(&id);
            } else {
                state.cleanup.push_back(id);
            }
        }
        if !state.buckets.contains_key(&device) {
            state.cleanup.push_back(device);
        }
        let (tokens, last) = state.buckets.entry(device).or_insert((capacity, now));
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

    #[sqlx::test]
    async fn maximum_counter_rejects_without_overflow_or_reducing_usage(pool: PgPool) {
        // One transaction fixes the current window throughout this test.
        let mut tx = pool.begin().await.unwrap();
        let key = "extreme-counter";
        tx_take(&mut tx, key, i32::MAX - 1, i32::MAX, MINUTE)
            .await
            .unwrap();
        tx_take(&mut tx, key, 1, i32::MAX, MINUTE).await.unwrap();
        assert!(matches!(
            tx_take(&mut tx, key, 1, i32::MAX, MINUTE).await,
            Err(ApiError::TooManyRequests(_))
        ));
        assert!(matches!(
            tx_take(&mut tx, key, -1, i32::MAX, MINUTE).await,
            Err(ApiError::TooManyRequests(_))
        ));
        let count: i32 = sqlx::query_scalar("SELECT count FROM rate_limits WHERE key = $1")
            .bind(key)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(count, i32::MAX);
    }

    #[test]
    fn token_bucket_allows_a_burst_then_refills() {
        let buckets = SendBuckets::default();
        let device = Uuid::new_v4();
        assert!((0..3).all(|_| buckets.allow(device, 3)));
        assert!(!buckets.allow(device, 3));
        assert!(buckets.allow(Uuid::new_v4(), 3), "per device");
    }

    #[test]
    fn idle_send_buckets_are_removed_with_bounded_work() {
        let buckets = SendBuckets::default();
        let now = Instant::now();
        for _ in 0..100 {
            assert!(buckets.allow_with_clock(Uuid::new_v4(), 1, || now));
        }
        let active = Uuid::new_v4();
        assert!(buckets.allow_with_clock(active, 1, || now + Duration::from_secs(30)));
        assert!(!buckets.allow_with_clock(active, 1, || now + Duration::from_secs(60)));
        {
            let state = buckets.state.lock().unwrap();
            assert_eq!(state.buckets.len(), 37, "only 64 entries scanned");
            assert_eq!(state.cleanup.len(), state.buckets.len());
        }
        assert!(!buckets.allow_with_clock(active, 1, || now + Duration::from_secs(60)));
        let state = buckets.state.lock().unwrap();
        assert_eq!(
            state.buckets.len(),
            1,
            "all idle entries eventually removed"
        );
        assert_eq!(state.cleanup.len(), 1);
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

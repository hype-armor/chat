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
    time::Instant,
};

use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::request::Parts,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{AppState, error::ApiError};

#[derive(Clone, Debug)]
pub struct Limits {
    pub lookups_per_hour: i32,
    pub claims_per_hour: i32,
    /// Devices a device may welcome (first contact) per day.
    pub welcomes_per_day: i32,
    pub sends_per_minute: u32,
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
            registrations_per_ip_per_hour: 10,
            registrations_per_day: 1_000,
            invites_per_day: 10,
            links_per_ip_per_hour: 20,
            reports_per_day: 20,
            device_lists_per_hour: 120,
            restores_per_ip_per_hour: 10,
            blob_mb_per_day: 2_048,
            restores_per_account_per_day: 10,
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
    .fetch_optional(db)
    .await?;
    allowed.map(|_| ()).ok_or_else(refused)
}

pub const HOUR: i64 = 3600;
pub const DAY: i64 = 86_400;

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
}

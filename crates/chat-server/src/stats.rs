//! Call statistics from clients that opted in (ADR-0032): daily totals of
//! call outcomes and setup times, with no account, device, conversation or
//! per-call timing, folded into the Prometheus counters and kept nowhere
//! else. Measures Phase 3's exit criterion (call success ≥ 99 %).

use axum::{Json, extract::State, http::StatusCode};
use serde::Deserialize;

use crate::{
    AppState,
    auth::db,
    error::ApiError,
    limits::{self, ClientIp},
};

/// Most outcomes and setup times one report may carry (a day's calls).
const MAX_CALLS: u32 = 500;
const MAX_SETUP_SAMPLES: usize = 100;
const MAX_SETUP_SECONDS: f64 = 120.0;
const REPORTS_PER_IP_PER_DAY: i32 = 6;

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Outcomes {
    #[serde(default)]
    connected: u32,
    #[serde(default)]
    failed: u32,
    /// Seconds from start or answer to media, one per connected call.
    #[serde(default)]
    setup_seconds: Vec<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallStats {
    #[serde(default)]
    direct: Outcomes,
    #[serde(default)]
    group: Outcomes,
}

/// `POST /v1/stats/calls`, unauthenticated so reports can't be tied to an account.
pub async fn calls(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(stats): Json<CallStats>,
) -> Result<StatusCode, ApiError> {
    for o in [&stats.direct, &stats.group] {
        if o.connected + o.failed > MAX_CALLS
            || o.setup_seconds.len() > MAX_SETUP_SAMPLES
            || o.setup_seconds
                .iter()
                .any(|s| !(0.0..=MAX_SETUP_SECONDS).contains(s))
        {
            return Err(ApiError::BadRequest("implausible call statistics"));
        }
    }
    if let Some(ip) = ip {
        let key = format!("call-stats-ip:{ip}");
        limits::take(db(&state)?, &key, 1, REPORTS_PER_IP_PER_DAY, limits::DAY).await?;
    }
    let m = &state.metrics;
    for (kind, o) in [("direct", &stats.direct), ("group", &stats.group)] {
        m.calls
            .get_or_create(&vec![("kind", kind), ("outcome", "connected")])
            .inc_by(o.connected.into());
        m.calls
            .get_or_create(&vec![("kind", kind), ("outcome", "failed")])
            .inc_by(o.failed.into());
        let setup = m.call_setup_seconds.get_or_create(&vec![("kind", kind)]);
        for s in &o.setup_seconds {
            setup.observe(*s);
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

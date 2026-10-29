//! Prometheus metrics (doc 03 §observability), served on their own port
//! (`CHAT_METRICS_BIND`) that the ingress does not route. Aggregates only:
//! no per-device, per-account or per-conversation labels.

use std::time::Duration;

use axum::{Router, extract::State, http::header, response::IntoResponse, routing::get};
use prometheus_client::{
    encoding::text::encode,
    metrics::{
        counter::Counter,
        family::Family,
        gauge::Gauge,
        histogram::{Histogram, exponential_buckets},
    },
    registry::Registry,
};

use crate::AppState;

pub struct Metrics {
    registry: Registry,
    /// Time to handle a WebSocket send: checks, queueing, wake-ups.
    pub send_seconds: Histogram,
    /// Queue to socket for envelopes delivered to a connected device.
    pub delivery_seconds: Histogram,
    /// Refused WebSocket sends by status code (400, 403, 429, ...).
    pub send_errors: Family<Vec<(&'static str, String)>, Counter>,
    pub connections: Gauge,
}

impl Default for Metrics {
    fn default() -> Self {
        // 1 ms to ~16 s.
        let buckets = || exponential_buckets(0.001, 2.0, 15);
        let send_seconds = Histogram::new(buckets());
        let delivery_seconds = Histogram::new(buckets());
        let send_errors = Family::default();
        let connections = Gauge::default();
        let mut registry = Registry::with_prefix("chat");
        registry.register(
            "send_seconds",
            "Time to handle a WebSocket send",
            send_seconds.clone(),
        );
        registry.register(
            "delivery_seconds",
            "Time from queueing to writing an envelope to a connected device",
            delivery_seconds.clone(),
        );
        registry.register(
            "send_errors",
            "Refused WebSocket sends by status code",
            send_errors.clone(),
        );
        registry.register(
            "websocket_connections",
            "Authenticated WebSocket connections",
            connections.clone(),
        );
        Self {
            registry,
            send_seconds,
            delivery_seconds,
            send_errors,
            connections,
        }
    }
}

impl Metrics {
    pub fn observe_send(&self, took: Duration, status: Option<u16>) {
        self.send_seconds.observe(took.as_secs_f64());
        if let Some(code) = status {
            self.send_errors
                .get_or_create(&vec![("code", code.to_string())])
                .inc();
        }
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        encode(&mut out, &self.registry).expect("writing to a String cannot fail");
        out
    }
}

/// Counts a connection for as long as it lives.
pub struct ConnectionGuard(Gauge);

impl ConnectionGuard {
    pub fn new(gauge: &Gauge) -> Self {
        gauge.inc();
        Self(gauge.clone())
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.dec();
    }
}

/// The metrics listener's router.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/metrics", get(metrics))
        .with_state(state)
}

async fn metrics(State(state): State<AppState>) -> impl IntoResponse {
    (
        [(
            header::CONTENT_TYPE,
            "application/openmetrics-text; version=1.0.0; charset=utf-8",
        )],
        state.metrics.render(),
    )
}

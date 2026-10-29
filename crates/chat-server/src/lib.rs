//! Chat server: a modular monolith (ADR-0005). Modules for blobs, push and
//! call signalling are added here as they land.

mod account;
mod auth;
mod backup;
pub mod blobs;
pub mod config;
mod delivery;
mod devices;
mod error;
mod groups;
mod hub;
pub mod invites;
pub mod keys;
pub mod limits;
pub mod metrics;
pub mod push;
mod reports;
mod ws;

use std::{sync::Arc, time::Duration};

use axum::{
    Router,
    extract::State,
    http::StatusCode,
    routing::{get, post, put},
};
use sqlx::PgPool;

pub use config::Config;

#[derive(Clone)]
pub struct AppState {
    pub db: Option<PgPool>,
    pub hub: hub::Hub,
    pub push: Option<Arc<push::PushSender>>,
    pub limits: limits::Limits,
    pub send_buckets: Arc<limits::SendBuckets>,
    pub metrics: Arc<metrics::Metrics>,
    /// Sign-up without an invite (ADR-0021); off in production.
    pub open_registration: bool,
    /// Encrypted attachments (ADR-0023); `None` turns them off.
    pub blobs: Option<Arc<dyn object_store::ObjectStore>>,
}

impl AppState {
    pub fn new(db: Option<PgPool>) -> Self {
        Self {
            db,
            open_registration: false,
            blobs: None,
            hub: hub::Hub::default(),
            push: None,
            limits: limits::Limits::default(),
            send_buckets: Arc::default(),
            metrics: Arc::default(),
        }
    }

    pub fn with_blobs(mut self, store: Arc<dyn object_store::ObjectStore>) -> Self {
        self.blobs = Some(store);
        self
    }

    pub fn with_open_registration(mut self, open: bool) -> Self {
        self.open_registration = open;
        self
    }

    pub fn with_limits(mut self, limits: limits::Limits) -> Self {
        self.limits = limits;
        self
    }

    pub fn with_push(mut self, push: push::PushSender) -> Self {
        self.push = Some(Arc::new(push));
        self
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(None)
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(readyz))
        .route("/v1/register", post(auth::register))
        .route("/v1/invites", post(invites::create))
        .route("/v1/keys", post(keys::upload))
        .route("/v1/keys/claim", post(keys::claim))
        .route("/v1/keys/count", get(keys::count))
        .route("/v1/lookup", post(keys::lookup))
        .route("/v1/groups/epoch", post(groups::epoch))
        .route("/v1/link/start", post(devices::start))
        .route("/v1/link/approve", post(devices::approve))
        .route("/v1/link/status", post(devices::status))
        .route("/v1/link/complete", post(devices::complete))
        .route("/v1/devices", get(devices::list))
        .route("/v1/devices/remove", post(devices::remove))
        .route("/v1/devices/of", post(devices::of))
        .route(
            "/v1/backup",
            put(backup::upload)
                .get(backup::download)
                .layer(axum::extract::DefaultBodyLimit::max(
                    backup::MAX_BACKUP_BYTES,
                )),
        )
        .route(
            "/v1/blobs",
            put(blobs::upload).layer(axum::extract::DefaultBodyLimit::max(
                blobs::MAX_BLOB_BYTES as usize,
            )),
        )
        .route("/v1/blobs/{id}", get(blobs::download))
        .route("/v1/backup/key", put(backup::set_key))
        .route("/v1/backup/delete", post(backup::delete))
        .route("/v1/backup/restore", post(backup::restore))
        .route("/v1/reports", post(reports::create))
        .route("/v1/account/delete", post(account::delete))
        .route("/v1/push/key", get(push::public_key))
        .route("/v1/push/subscription", post(push::subscribe))
        .route("/v1/push/unsubscribe", post(push::unsubscribe))
        .route("/v1/ws", get(ws::upgrade))
        .with_state(state)
}

/// Kubernetes readiness: ready once the database (if configured) answers.
async fn readyz(State(state): State<AppState>) -> (StatusCode, &'static str) {
    match &state.db {
        Some(db) => match sqlx::query("SELECT 1").execute(db).await {
            Ok(_) => (StatusCode::OK, "ready"),
            Err(e) => {
                tracing::warn!(error = %e, "readiness check failed");
                (StatusCode::SERVICE_UNAVAILABLE, "database unavailable")
            }
        },
        None => (StatusCode::OK, "ready (no database configured)"),
    }
}

pub async fn connect_db(url: &str) -> anyhow::Result<PgPool> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(url)
        .await?;
    migrate(&pool).await?;
    Ok(pool)
}

pub async fn migrate(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

/// Hourly retention cleanup (30-day queue, expired keys and codes).
pub async fn run_maintenance(db: PgPool) {
    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    loop {
        interval.tick().await;
        if let Err(e) = delivery::expire(&db).await {
            tracing::error!(error = %e, "retention cleanup failed");
        }
    }
}

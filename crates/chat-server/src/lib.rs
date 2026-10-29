//! Chat server: a modular monolith (ADR-0005). Modules for accounts, keys,
//! delivery, blobs, push and call signalling are added here as they land.

pub mod config;
mod ws;

use axum::{Router, extract::State, http::StatusCode, routing::get};
use sqlx::PgPool;

pub use config::Config;

#[derive(Clone, Default)]
pub struct AppState {
    pub db: Option<PgPool>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(readyz))
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
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

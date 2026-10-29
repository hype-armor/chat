use std::sync::Arc;

use chat_server::{AppState, Config, connect_db, router, run_maintenance, sms::LogSender};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    if config.json_logs {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    let db = match &config.database_url {
        Some(url) => {
            let db = connect_db(url).await?;
            tokio::spawn(run_maintenance(db.clone()));
            Some(db)
        }
        None => {
            tracing::warn!("DATABASE_URL not set; running without a database");
            None
        }
    };

    let listener = TcpListener::bind(config.bind).await?;
    tracing::info!(addr = %config.bind, "listening");
    // Only the log sender exists so far; real SMS providers plug in here.
    let state = AppState::new(db, Arc::new(LogSender));
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Kubernetes sends SIGTERM before killing a pod; stop accepting new
/// connections and let in-flight requests finish.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutting down");
}

use std::sync::Arc;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chat_server::{
    AppState, Config, connect_db, push::PushSender, router, run_maintenance, sms::LogSender,
};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("generate-vapid-key") {
        // Prints a new Web Push key pair for CHAT_VAPID_PRIVATE_KEY.
        let (private, public) = PushSender::generate_key_pair()?;
        println!("CHAT_VAPID_PRIVATE_KEY={private}\n# public key: {public}");
        return Ok(());
    }
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
    let push = match &config.vapid_private_key {
        Some(key) => PushSender::new(
            &URL_SAFE_NO_PAD.decode(key)?,
            config.vapid_subject.clone(),
            false,
        )?,
        None => {
            tracing::warn!(
                "CHAT_VAPID_PRIVATE_KEY not set; using a random key (push subscriptions break on restart)"
            );
            PushSender::generate(config.vapid_subject.clone(), false)?
        }
    };
    let state = AppState::new(db, Arc::new(LogSender))
        .with_push(push)
        .with_limits(config.limits.clone());
    if let Some(addr) = config.metrics_bind {
        let metrics = TcpListener::bind(addr).await?;
        tracing::info!(%addr, "metrics listening");
        let app = chat_server::metrics::router(state.clone());
        tokio::spawn(async move { axum::serve(metrics, app).await });
    }
    // Peer addresses feed per-IP limits when no trusted proxy header is set.
    let app = router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    axum::serve(listener, app)
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

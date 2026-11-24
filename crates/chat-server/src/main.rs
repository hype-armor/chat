use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chat_server::{
    AppState, Config, connect_db, invites, push::PushSender, router, run_maintenance,
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
    if std::env::args().nth(1).as_deref() == Some("create-invite") {
        // The operator's invite for the first account (ADR-0021). Usage:
        // chat-server create-invite [https://chat.example.com] [--code-file PATH]
        // `--code-file` also writes the bare code to PATH (e.g. for the echo
        // test bot's first sign-up in docker compose).
        let url = config
            .database_url
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("DATABASE_URL is required"))?;
        let code = invites::create_invite(&connect_db(url).await?, None)
            .await
            .map_err(|e| anyhow::anyhow!("creating the invite failed: {}", e.message()))?;
        let mut args = std::env::args().skip(2);
        let mut base = "https://<host>".to_owned();
        while let Some(arg) = args.next() {
            if arg == "--code-file" {
                let path = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--code-file needs a path"))?;
                std::fs::write(path, &code)?;
            } else {
                base = arg;
            }
        }
        println!("invite code: {code}\nlink (valid 7 days): {base}/#invite={code}");
        return Ok(());
    }
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

    if config.experimental_presence {
        if let Some(db) = db.clone() {
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    if chat_server::presence::purge_expired(&db).await.is_err() {
                        tracing::error!("presence expiry cleanup failed");
                    }
                }
            });
        }
    }

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
    }
    .with_allowed_hosts(config.push_hosts.clone());
    if config.open_registration {
        tracing::warn!("CHAT_REGISTRATION=open: anyone can sign up without an invite");
    }
    if config.blob_store == "memory" {
        tracing::warn!(
            "CHAT_BLOB_STORE not set: attachments are kept in memory and lost on restart"
        );
    }
    let blobs = chat_server::blobs::open_store(&config.blob_store)?;
    if let Some(db) = &db {
        // Backups made while they lived in PostgreSQL (migration 0010).
        chat_server::backup::move_to_store(db, &blobs).await?;
    }
    let state = AppState::new(db)
        .with_blobs(blobs.clone())
        .with_open_registration(config.open_registration)
        .with_experimental_presence(config.experimental_presence)
        .with_turn(config.turn.clone())
        .with_livekit(config.livekit.clone())
        .with_tiles(config.tiles.clone())
        .with_push(push)
        .with_limits(config.limits.clone());
    if let Some(addr) = config.metrics_bind {
        let metrics = TcpListener::bind(addr).await?;
        tracing::info!(%addr, "metrics listening");
        let app = chat_server::metrics::router(state.clone());
        tokio::spawn(async move { axum::serve(metrics, app).await });
    }
    // Stop scheduling expiry on shutdown, but let an active pass finish.
    let (stop_expiry, expiry_stop_rx) = tokio::sync::watch::channel(false);
    let expiry = state.db.clone().map(|db| {
        let store = blobs.clone();
        tokio::spawn(run_expiry_loop(
            expiry_stop_rx,
            tokio::time::interval(std::time::Duration::from_secs(3600)),
            move || {
                let db = db.clone();
                let store = store.clone();
                async move {
                    if let Err(e) = chat_server::blobs::expire(&db, &store).await {
                        tracing::error!(error = %e, "expiring attachments failed");
                    }
                }
            },
        ))
    });
    // Peer addresses feed per-IP limits when no trusted proxy header is set.
    let app = router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    let signal_expiry = stop_expiry.clone();
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            let _ = signal_expiry.send(true);
        })
        .await;
    finish_server(result, stop_expiry, expiry).await
}

async fn finish_server(
    result: std::io::Result<()>,
    stop_expiry: tokio::sync::watch::Sender<bool>,
    expiry: Option<tokio::task::JoinHandle<()>>,
) -> anyhow::Result<()> {
    // Also stop the loop when the server exits with an error.
    let _ = stop_expiry.send(true);
    if let Some(expiry) = expiry {
        // Do not cancel an active pass. Forced termination is not a safe drain.
        // This join has no timeout, so shutdown can wait indefinitely.
        expiry.await?;
    }
    result?;
    Ok(())
}

async fn run_expiry_loop<F, Fut>(
    mut stop: tokio::sync::watch::Receiver<bool>,
    mut hourly: tokio::time::Interval,
    mut expire: F,
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    loop {
        if *stop.borrow() {
            break;
        }
        tokio::select! {
            biased;
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
            _ = hourly.tick() => {
                if *stop.borrow() {
                    break;
                }
                expire().await;
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use super::{finish_server, run_expiry_loop};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::{oneshot, watch};
    use tokio::time::{Duration, Instant, interval, interval_at, timeout};

    #[tokio::test]
    async fn shutdown_joins_active_expiry_without_starting_another() {
        timeout(Duration::from_secs(5), async {
            let (stop_tx, stop_rx) = watch::channel(false);
            let (started_tx, started_rx) = oneshot::channel();
            let (finish_tx, finish_rx) = oneshot::channel();
            let calls = Arc::new(AtomicUsize::new(0));
            let count = calls.clone();
            let mut started = Some(started_tx);
            let mut finish = Some(finish_rx);
            // Both the first and the next tick are due before the pass starts.
            // The stop signal and the next tick are ready when the pass ends.
            let ticks = interval_at(
                Instant::now() - Duration::from_secs(7200),
                Duration::from_secs(3600),
            );
            let task = tokio::spawn(run_expiry_loop(stop_rx, ticks, move || {
                count.fetch_add(1, Ordering::SeqCst);
                let started = started.take();
                let finish = finish.take();
                async move {
                    started.unwrap().send(()).unwrap();
                    finish.unwrap().await.unwrap();
                }
            }));
            started_rx.await.unwrap();
            stop_tx.send(true).unwrap();
            tokio::task::yield_now().await;
            assert!(!task.is_finished());
            finish_tx.send(()).unwrap();
            task.await.unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        })
        .await
        .expect("expiry loop did not stop");
    }

    #[tokio::test]
    async fn server_error_stops_and_joins_expiry() {
        timeout(Duration::from_secs(5), async {
            let (stop_tx, mut stop_rx) = watch::channel(false);
            let (observed_tx, observed_rx) = oneshot::channel();
            let (finish_tx, finish_rx) = oneshot::channel();
            let expiry = tokio::spawn(async move {
                stop_rx.changed().await.unwrap();
                assert!(*stop_rx.borrow());
                observed_tx.send(()).unwrap();
                finish_rx.await.unwrap();
            });
            let server = tokio::spawn(finish_server(
                Err(std::io::Error::other("server failed")),
                stop_tx,
                Some(expiry),
            ));
            observed_rx.await.unwrap();
            assert!(!server.is_finished());
            finish_tx.send(()).unwrap();
            assert!(
                server
                    .await
                    .unwrap()
                    .unwrap_err()
                    .to_string()
                    .contains("server failed")
            );
        })
        .await
        .expect("server error cleanup did not finish");
    }

    #[tokio::test]
    async fn shutdown_before_first_tick_starts_no_expiry() {
        timeout(Duration::from_secs(5), async {
            let (stop_tx, stop_rx) = watch::channel(false);
            stop_tx.send(true).unwrap();
            run_expiry_loop(stop_rx, interval(Duration::from_secs(3600)), || async {
                panic!("expiry started after shutdown")
            })
            .await;
        })
        .await
        .expect("expiry loop did not stop");
    }
}

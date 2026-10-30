//! `chat-echo`: runs the echo test bot against a chat server.
//!
//! Environment:
//! - `ECHO_SERVER`: the server's base URL (default `http://localhost:8080`);
//! - `ECHO_USERNAME`: the bot's username (default `echo.00`);
//! - `ECHO_INVITE`, or `ECHO_INVITE_FILE` naming a file that holds one: an
//!   invite code, needed once in invite-only mode;
//! - `ECHO_STATE_DIR`: where its account and keys are kept (default `./echo-state`);
//! - `ECHO_HEALTH_BIND`: optional address answering `200` while connected
//!   (readiness checks), e.g. `127.0.0.1:8090`.
//!
//! For development and testing only: its keys live on the machine it runs
//! on, and it reads whatever is sent to it.

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use chat_core::{client::Client, mls::PendingDevice};
use chat_echo::{DISPLAY_NAME, Echo};
use chat_proto::v1::{
    Ack, Authenticate, ClientFrame, Ping, SendEnvelope, ServerFrame, client_frame, server_frame,
};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

/// Key packages kept on the server, like the web client (ADR-0021).
const KEY_PACKAGE_TARGET: usize = 20;
const KEY_PACKAGE_REFILL_BELOW: u32 = 10;

struct Config {
    server: String,
    username: String,
    invite: Option<String>,
    state_dir: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct Account {
    account_id: Uuid,
    device_id: Uuid,
    token: String,
    username: String,
}

/// The server no longer accepts our token (state from another database).
#[derive(Debug)]
struct Unauthorized;

impl std::fmt::Display for Unauthorized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the server refused this bot's token")
    }
}

impl std::error::Error for Unauthorized {}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "chat_echo=info".into()),
        )
        .init();
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let config = Config {
        server: env("ECHO_SERVER")
            .unwrap_or_else(|| "http://localhost:8080".into())
            .trim_end_matches('/')
            .to_owned(),
        username: env("ECHO_USERNAME").unwrap_or_else(|| "echo.00".into()),
        invite: env("ECHO_INVITE").or_else(|| {
            let file = env("ECHO_INVITE_FILE")?;
            std::fs::read_to_string(file)
                .ok()
                .map(|code| code.trim().to_owned())
        }),
        state_dir: env("ECHO_STATE_DIR")
            .unwrap_or_else(|| "echo-state".into())
            .into(),
    };
    tokio::fs::create_dir_all(&config.state_dir).await?;
    let connected = Arc::new(AtomicBool::new(false));
    if let Some(addr) = env("ECHO_HEALTH_BIND") {
        let listener = tokio::net::TcpListener::bind(&addr).await?;
        tokio::spawn(health(listener, connected.clone()));
    }
    tracing::warn!("echo bot for development and testing: it reads what it is sent");
    let http = reqwest::Client::new();
    let mut backoff = Duration::from_secs(1);
    loop {
        let result = run(&config, &http, &connected).await;
        connected.store(false, Ordering::Relaxed);
        match result {
            Ok(()) => backoff = Duration::from_secs(1),
            Err(e) if e.is::<Unauthorized>() => {
                // A reset database: start over as a new account.
                tracing::warn!("{e}; registering again");
                let _ = tokio::fs::remove_file(config.state_dir.join("account.json")).await;
                let _ = tokio::fs::remove_file(config.state_dir.join("core.bin")).await;
                continue;
            }
            Err(e) => tracing::warn!("{e:#}; retrying in {backoff:?}"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

/// Answers every request with 200 while connected, else 503.
async fn health(listener: tokio::net::TcpListener, connected: Arc<AtomicBool>) {
    while let Ok((mut socket, _)) = listener.accept().await {
        let up = connected.load(Ordering::Relaxed);
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let status = if up {
                "200 OK"
            } else {
                "503 Service Unavailable"
            };
            let reply =
                format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            let _ = socket.write_all(reply.as_bytes()).await;
        });
    }
}

async fn write_atomic(path: PathBuf, data: &[u8]) -> anyhow::Result<()> {
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, data).await?;
    tokio::fs::rename(&tmp, &path).await?;
    Ok(())
}

async fn save(config: &Config, client: &Client) -> anyhow::Result<()> {
    write_atomic(config.state_dir.join("core.bin"), &client.snapshot()?).await
}

/// This bot's account and keys: from disk, or a new registration.
async fn load_or_register(
    config: &Config,
    http: &reqwest::Client,
) -> anyhow::Result<(Account, Client)> {
    let account_path = config.state_dir.join("account.json");
    if let (Ok(account), Ok(core)) = (
        tokio::fs::read(&account_path).await,
        tokio::fs::read(config.state_dir.join("core.bin")).await,
    ) {
        return Ok((serde_json::from_slice(&account)?, Client::restore(&core)?));
    }
    let pending = PendingDevice::generate()?;
    let res = http
        .post(format!("{}/v1/register", config.server))
        .json(&serde_json::json!({
            "username": config.username,
            "invite": config.invite,
            "identity_key": STANDARD.encode(pending.public_key()),
        }))
        .send()
        .await
        .context("reaching the server")?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        bail!(
            "registering {} failed ({status}): {body}. In invite-only mode set ECHO_INVITE \
             (chat-server create-invite); a taken username needs ECHO_USERNAME",
            config.username
        );
    }
    let account: Account = res.json().await?;
    let identity = [
        account.account_id.as_bytes().as_slice(),
        account.device_id.as_bytes(),
    ]
    .concat();
    let client = Client::new(pending.into_device(&identity)?);
    upload_key_packages(config, http, &account, &client, KEY_PACKAGE_TARGET).await?;
    write_atomic(account_path, &serde_json::to_vec(&account)?).await?;
    save(config, &client).await?;
    tracing::info!(username = %account.username, "registered");
    Ok((account, client))
}

async fn upload_key_packages(
    config: &Config,
    http: &reqwest::Client,
    account: &Account,
    client: &Client,
    count: usize,
) -> anyhow::Result<()> {
    let packages: Vec<String> = client
        .key_packages(count)?
        .iter()
        .map(|k| STANDARD.encode(k))
        .collect();
    let res = http
        .post(format!("{}/v1/keys", config.server))
        .bearer_auth(&account.token)
        .json(&serde_json::json!({ "key_packages": packages }))
        .send()
        .await?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Unauthorized.into());
    }
    res.error_for_status()?;
    Ok(())
}

fn frame(request_id: u64, body: client_frame::Body) -> Message {
    Message::Binary(
        ClientFrame {
            request_id,
            body: Some(body),
        }
        .encode_to_vec()
        .into(),
    )
}

/// One connection: authenticate, then echo deliveries until it drops.
async fn run(
    config: &Config,
    http: &reqwest::Client,
    connected: &AtomicBool,
) -> anyhow::Result<()> {
    let (account, client) = load_or_register(config, http).await?;
    let mut echo = Echo::new(client, DISPLAY_NAME);
    let url = format!(
        "{}/v1/ws",
        config.server.replacen("http", "ws", 1) // http→ws, https→wss
    );
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .with_context(|| format!("connecting to {url}"))?;
    let (mut sink, mut stream) = ws.split();
    let mut next_id = 1u64;
    sink.send(frame(
        next_id,
        client_frame::Body::Authenticate(Authenticate {
            token: account.token.clone(),
        }),
    ))
    .await?;
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        let msg = tokio::select! {
            msg = stream.next() => match msg {
                Some(msg) => msg?,
                None => return Ok(()),
            },
            _ = ping.tick() => {
                next_id += 1;
                sink.send(frame(next_id, client_frame::Body::Ping(Ping {}))).await?;
                continue;
            }
        };
        let Message::Binary(bytes) = msg else {
            continue;
        };
        let server = ServerFrame::decode(bytes.as_ref())?;
        match server.body {
            Some(server_frame::Body::AuthResult(auth)) => {
                tracing::info!(username = %account.username, "connected");
                connected.store(true, Ordering::Relaxed);
                if auth.key_packages < KEY_PACKAGE_REFILL_BELOW {
                    let missing = KEY_PACKAGE_TARGET - auth.key_packages as usize;
                    upload_key_packages(config, http, &account, echo.client(), missing).await?;
                    save(config, echo.client()).await?;
                }
            }
            Some(server_frame::Body::Deliver(env)) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_millis() as u64;
                let replies = echo.handle(&env, now).unwrap_or_else(|e| {
                    tracing::warn!("could not process a message: {e}");
                    Vec::new()
                });
                // Keys first, then replies, then the ack (the server deletes on ack).
                save(config, echo.client()).await?;
                for out in replies {
                    next_id += 1;
                    sink.send(frame(
                        next_id,
                        client_frame::Body::Send(SendEnvelope {
                            envelope: Some(out.envelope),
                            recipient_devices: out.recipients,
                            silent: out.silent,
                            ..SendEnvelope::default()
                        }),
                    ))
                    .await?;
                }
                sink.send(frame(
                    0,
                    client_frame::Body::Ack(Ack {
                        message_id: env.message_id,
                    }),
                ))
                .await?;
            }
            Some(server_frame::Body::Error(e)) if e.code == 401 => return Err(Unauthorized.into()),
            Some(server_frame::Body::Error(e)) => {
                tracing::warn!(code = e.code, "server error: {}", e.message)
            }
            Some(server_frame::Body::SendResult(r)) if !r.accepted => {
                tracing::warn!("a reply was not accepted")
            }
            _ => {}
        }
    }
}

//! Delivery latency load test (NFR-PERF-1: p95 < 1 s with both parties
//! online). Starts the server in-process against a real PostgreSQL,
//! registers users, puts them in groups and has every user send to its
//! group at a steady rate over real WebSockets. Each envelope carries its
//! send time, so the receiver measures send-to-receive latency.
//!
//! ```sh
//! DATABASE_URL=postgres://... cargo run --release -p chat-server --example loadtest -- \
//!     --users 200 --group-size 5 --rate 1 --seconds 30
//! ```
//!
//! Use a throwaway database: the test leaves its users behind. Exits
//! non-zero when p95 is 1 s or more.

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chat_proto::{
    PROTOCOL_VERSION,
    v1::{
        Ack, Authenticate, ClientFrame, ContentType, Envelope, SendEnvelope, ServerFrame,
        client_frame, server_frame,
    },
};
use chat_server::{AppState, limits::Limits, router};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

/// Padded size of a short text message (doc 05 padding buckets).
const CIPHERTEXT_BYTES: usize = 256;

struct Args {
    users: usize,
    group_size: usize,
    rate: f64,
    seconds: u64,
}

fn args() -> Args {
    let mut a = Args {
        users: 200,
        group_size: 5,
        rate: 1.0,
        seconds: 30,
    };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    for pair in argv.chunks(2) {
        let value = pair.get(1).map(String::as_str).unwrap_or_default();
        match pair[0].as_str() {
            "--users" => a.users = value.parse().expect("--users"),
            "--group-size" => a.group_size = value.parse().expect("--group-size"),
            "--rate" => {
                a.rate = value
                    .parse()
                    .expect("--rate (messages per second per user)")
            }
            "--seconds" => a.seconds = value.parse().expect("--seconds"),
            other => panic!("unknown argument {other}"),
        }
    }
    assert!(a.group_size >= 2 && a.users >= a.group_size);
    a
}

#[derive(Default)]
struct Stats {
    latencies: Vec<f64>,
    sent: usize,
    refused: usize,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = args();
    let db = chat_server::connect_db(&std::env::var("DATABASE_URL")?).await?;
    let limits = Limits {
        registrations_per_ip_per_hour: i32::MAX,
        registrations_per_day: i32::MAX,
        ..Limits::default()
    };
    let state = AppState::new(Some(db.clone()))
        .with_open_registration(true)
        .with_limits(limits);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(axum::serve(listener, router(state.clone())).into_future());
    let http = reqwest::Client::new();
    let base = format!("http://{addr}");

    // Register users, a few at a time.
    let run: u32 = rand::random_range(0..1000);
    let started = Instant::now();
    let mut users = Vec::new();
    for chunk in (0..args.users).collect::<Vec<_>>().chunks(20) {
        let batch = chunk
            .iter()
            .map(|i| register(&http, &base, format!("l{run:03}{i:07}.10")));
        users.extend(futures_util::future::try_join_all(batch).await?);
    }
    println!(
        "registered {} users in {:.1} s",
        users.len(),
        started.elapsed().as_secs_f64()
    );

    // Groups of `group_size` (the last one may be larger).
    let groups: Vec<Vec<usize>> = {
        let n = args.users / args.group_size;
        (0..n)
            .map(|g| {
                let end = if g == n - 1 {
                    args.users
                } else {
                    (g + 1) * args.group_size
                };
                (g * args.group_size..end).collect()
            })
            .collect()
    };
    for (g, members) in groups.iter().enumerate() {
        let devices: Vec<Uuid> = members.iter().map(|&i| users[i].0).collect();
        sqlx::query(
            "INSERT INTO conversation_members (conversation_id, device_id)
             SELECT $1, d FROM UNNEST($2::uuid[]) AS d",
        )
        .bind(conversation_id(run, g))
        .bind(&devices)
        .execute(&db)
        .await?;
    }

    let stats = Arc::new(Mutex::new(Stats::default()));
    let epoch = Instant::now();
    // Everyone connects before anyone sends.
    let start = Arc::new(tokio::sync::Barrier::new(args.users));
    let duration = Duration::from_secs(args.seconds);
    let mut tasks = Vec::new();
    for (g, members) in groups.iter().enumerate() {
        for &i in members {
            let peers: Vec<Uuid> = members
                .iter()
                .filter(|&&j| j != i)
                .map(|&j| users[j].0)
                .collect();
            let ws_url = format!("ws://{addr}/v1/ws");
            let token = users[i].1.clone();
            let stats = stats.clone();
            let start = start.clone();
            let conversation = conversation_id(run, g);
            let interval = Duration::from_secs_f64(1.0 / args.rate);
            tasks.push(tokio::spawn(async move {
                user(
                    ws_url,
                    token,
                    conversation,
                    peers,
                    interval,
                    epoch,
                    (start, duration),
                    stats,
                )
                .await
            }));
        }
    }
    for t in tasks {
        t.await??;
    }

    let mut stats = std::mem::take(&mut *stats.lock().unwrap());
    stats.latencies.sort_by(f64::total_cmp);
    let l = &stats.latencies;
    let pct = |p: f64| {
        l.get(((l.len() as f64 * p) as usize).min(l.len().saturating_sub(1)))
            .copied()
            .unwrap_or(f64::NAN)
            * 1000.0
    };
    let expected = stats.sent * (args.group_size - 1);
    println!(
        "{} users, groups of {}, {} msg/s each for {} s",
        args.users, args.group_size, args.rate, args.seconds
    );
    println!(
        "sent {} ({} refused), delivered {} of ~{} ({:.0} deliveries/s)",
        stats.sent,
        stats.refused,
        l.len(),
        expected,
        l.len() as f64 / args.seconds as f64
    );
    println!(
        "latency ms: p50 {:.1}  p95 {:.1}  p99 {:.1}  max {:.1}",
        pct(0.50),
        pct(0.95),
        pct(0.99),
        pct(1.0)
    );
    if l.is_empty() || pct(0.95) >= 1000.0 {
        anyhow::bail!("p95 delivery latency is not below 1 s");
    }
    Ok(())
}

fn conversation_id(run: u32, group: usize) -> Vec<u8> {
    format!("load-{run}-{group}").into_bytes()
}

async fn register(
    http: &reqwest::Client,
    base: &str,
    username: String,
) -> anyhow::Result<(Uuid, String)> {
    let body: Value = http
        .post(format!("{base}/v1/register"))
        .json(&json!({ "username": username, "identity_key": "bG9hZHRlc3Q=" }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok((
        body["device_id"].as_str().unwrap_or_default().parse()?,
        body["token"].as_str().unwrap_or_default().to_owned(),
    ))
}

/// One user: connects, waits for everyone at `start`, then sends to its
/// group every `interval` for `duration`, records the latency of everything
/// it receives and acks it, and keeps reading for a few seconds after.
#[allow(clippy::too_many_arguments)]
async fn user(
    ws_url: String,
    token: String,
    conversation: Vec<u8>,
    peers: Vec<Uuid>,
    interval: Duration,
    epoch: Instant,
    (start, duration): (Arc<tokio::sync::Barrier>, Duration),
    stats: Arc<Mutex<Stats>>,
) -> anyhow::Result<()> {
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await?;
    let auth = ClientFrame {
        request_id: 0,
        body: Some(client_frame::Body::Authenticate(Authenticate { token })),
    };
    ws.send(Message::Binary(auth.encode_to_vec().into()))
        .await?;
    loop {
        let Some(Message::Binary(bytes)) = ws.next().await.transpose()? else {
            continue;
        };
        match ServerFrame::decode(bytes.as_ref())?.body {
            Some(server_frame::Body::AuthResult(_)) => break,
            other => anyhow::bail!("authentication failed: {other:?}"),
        }
    }
    let (mut sink, mut stream) = ws.split();
    let (out, mut outbox) = mpsc::unbounded_channel::<client_frame::Body>();
    let writer = tokio::spawn(async move {
        let mut request_id = 0;
        while let Some(body) = outbox.recv().await {
            request_id += 1;
            let frame = ClientFrame {
                request_id,
                body: Some(body),
            };
            if sink
                .send(Message::Binary(frame.encode_to_vec().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let reader_stats = stats.clone();
    let acks = out.clone();
    let reader = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Binary(bytes) = msg else {
                continue;
            };
            let Ok(frame) = ServerFrame::decode(bytes.as_ref()) else {
                continue;
            };
            match frame.body {
                Some(server_frame::Body::Deliver(env)) => {
                    let sent = u64::from_le_bytes(env.ciphertext[..8].try_into().unwrap());
                    let latency = epoch.elapsed().as_nanos() as u64 - sent;
                    reader_stats
                        .lock()
                        .unwrap()
                        .latencies
                        .push(latency as f64 / 1e9);
                    let _ = acks.send(client_frame::Body::Ack(Ack {
                        message_id: env.message_id,
                    }));
                }
                Some(server_frame::Body::Error(_)) => reader_stats.lock().unwrap().refused += 1,
                _ => {}
            }
        }
    });

    start.wait().await;
    let until = Instant::now() + duration;
    // Spread the first sends over one interval.
    tokio::time::sleep(interval.mul_f64(rand::random::<f64>())).await;
    let mut tick = tokio::time::interval(interval);
    let recipients: Vec<Vec<u8>> = peers.iter().map(|d| d.as_bytes().to_vec()).collect();
    loop {
        tick.tick().await;
        if Instant::now() >= until {
            break;
        }
        let mut ciphertext = vec![0u8; CIPHERTEXT_BYTES];
        ciphertext[..8].copy_from_slice(&(epoch.elapsed().as_nanos() as u64).to_le_bytes());
        out.send(client_frame::Body::Send(SendEnvelope {
            envelope: Some(Envelope {
                version: PROTOCOL_VERSION,
                conversation_id: conversation.clone(),
                epoch: 0,
                content_type: ContentType::Application.into(),
                ciphertext,
                message_id: Uuid::new_v4().as_bytes().to_vec(),
            }),
            recipient_devices: recipients.clone(),
            ..Default::default()
        }))?;
        stats.lock().unwrap().sent += 1;
    }
    // Let the last deliveries (to and from everyone) arrive.
    tokio::time::sleep_until((until + Duration::from_secs(3)).into()).await;
    reader.abort();
    drop(out);
    writer.abort();
    Ok(())
}

mod support;

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{Router, extract::State, http::HeaderMap, http::StatusCode, routing::post};
use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope, Ping, SendEnvelope, client_frame, server_frame},
};
use chat_server::push::PushSender;
use serde_json::json;
use sqlx::PgPool;
use support::{Client, TestServer};
use uuid::Uuid;

/// A fake push service: records requests, answers with a chosen status.
#[derive(Clone, Default)]
struct FakePushService {
    requests: Arc<Mutex<Vec<HeaderMap>>>,
    status: Arc<Mutex<u16>>,
}

impl FakePushService {
    async fn start() -> (Self, String) {
        let service = Self::default();
        *service.status.lock().unwrap() = 201;
        let app = Router::new()
            .route("/push/{id}", post(record))
            .with_state(service.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        (service, base)
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

async fn record(State(service): State<FakePushService>, headers: HeaderMap) -> StatusCode {
    service.requests.lock().unwrap().push(headers);
    StatusCode::from_u16(*service.status.lock().unwrap()).unwrap()
}

async fn eventually(mut check: impl FnMut() -> bool) -> bool {
    for _ in 0..100 {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

fn message(to_group: &[u8]) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION,
        conversation_id: to_group.to_vec(),
        epoch: 0,
        content_type: ContentType::Application.into(),
        ciphertext: b"opaque".to_vec(),
        message_id: Uuid::new_v4().as_bytes().to_vec(),
    }
}

async fn send(client: &mut Client, to: Uuid) {
    send_with(client, to, false).await
}

async fn send_with(client: &mut Client, to: Uuid, silent: bool) {
    let reply = client
        .request(client_frame::Body::Send(SendEnvelope {
            envelope: Some(message(b"g")),
            recipient_devices: vec![to.as_bytes().to_vec()],
            silent,
            ..Default::default()
        }))
        .await;
    assert!(matches!(reply.body, Some(server_frame::Body::SendResult(r)) if r.accepted));
}

#[sqlx::test]
async fn offline_devices_get_one_content_free_push(pool: PgPool) {
    let (service, base) = FakePushService::start().await;
    let push = PushSender::generate("mailto:test@example.com".into(), true).unwrap();
    let public_key = push.public_key().to_owned();
    let server = TestServer::start_with_push(pool.clone(), Some(push)).await;
    let http_base = server
        .ws_url
        .replace("ws://", "http://")
        .replace("/v1/ws", "");
    let key: serde_json::Value = reqwest::get(format!("{http_base}/v1/push/key"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(key["public_key"], public_key.as_str());

    let (alice_dev, alice_token) = server.register("u5550006001.10").await;
    let (bob, bob_token) = server.register("u5550006002.10").await;
    server.admit(b"g", &[alice_dev, bob]).await;
    let sub = json!({ "endpoint": format!("{base}/push/bob"), "keys": { "p256dh": "BOB_P256DH", "auth": "BOB_AUTH" } });
    let (status, _) = server
        .post("/v1/push/subscription", Some(&bob_token), sub)
        .await;
    assert_eq!(status, 204);

    let mut alice = server.connect(&alice_token).await;
    send(&mut alice, bob).await;
    assert!(
        eventually(|| service.count() == 1).await,
        "offline device is pushed"
    );
    let headers = service.requests.lock().unwrap()[0].clone();
    let auth = headers["authorization"].to_str().unwrap();
    assert!(
        auth.starts_with("vapid t=") && auth.contains(", k="),
        "{auth}"
    );
    assert_eq!(headers["content-length"], "0", "no payload");

    // A second message within the coalescing window doesn't push again.
    send(&mut alice, bob).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(service.count(), 1);

    // A connected device is woken over its socket instead.
    let mut bob_ws = server.connect(&bob_token).await;
    send(&mut alice, bob).await;
    bob_ws.request(client_frame::Body::Ping(Ping {})).await;
    assert_eq!(service.count(), 1);
}

#[sqlx::test]
async fn expired_subscriptions_are_deleted(pool: PgPool) {
    let (service, base) = FakePushService::start().await;
    *service.status.lock().unwrap() = 410;
    let push = PushSender::generate("mailto:test@example.com".into(), true).unwrap();
    let server = TestServer::start_with_push(pool.clone(), Some(push)).await;
    let (alice_dev, alice_token) = server.register("u5550006003.10").await;
    let (bob, bob_token) = server.register("u5550006004.10").await;
    server.admit(b"g", &[alice_dev, bob]).await;
    let sub =
        json!({ "endpoint": format!("{base}/push/bob"), "keys": { "p256dh": "k", "auth": "a" } });
    server
        .post("/v1/push/subscription", Some(&bob_token), sub)
        .await;

    let mut alice = server.connect(&alice_token).await;
    send(&mut alice, bob).await;
    assert!(eventually(|| service.count() == 1).await);
    let mut cleared = false;
    for _ in 0..100 {
        let (sub,): (Option<serde_json::Value>,) =
            sqlx::query_as("SELECT push_subscription FROM devices WHERE device_id = $1")
                .bind(bob)
                .fetch_one(&pool)
                .await
                .unwrap();
        if sub.is_none() {
            cleared = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(cleared, "410 Gone deletes the subscription");
}

#[sqlx::test]
async fn subscription_validation(pool: PgPool) {
    // Production config: only HTTPS endpoints.
    let push = PushSender::generate("mailto:test@example.com".into(), false).unwrap();
    let server = TestServer::start_with_push(pool, Some(push)).await;
    let (_, token) = server.register("u5550006005.10").await;
    let http =
        json!({ "endpoint": "http://push.example.com/x", "keys": { "p256dh": "k", "auth": "a" } });
    let (status, _) = server
        .post("/v1/push/subscription", Some(&token), http)
        .await;
    assert_eq!(status, 400);
    let https =
        json!({ "endpoint": "https://push.example.com/x", "keys": { "p256dh": "k", "auth": "a" } });
    let (status, _) = server
        .post("/v1/push/subscription", Some(&token), https.clone())
        .await;
    assert_eq!(status, 204);
    let (status, _) = server.post("/v1/push/subscription", None, https).await;
    assert_eq!(status, 401);
    let (status, _) = server
        .post("/v1/push/unsubscribe", Some(&token), json!({}))
        .await;
    assert_eq!(status, 204);
}

#[sqlx::test]
async fn silent_sends_do_not_push(pool: PgPool) {
    let (service, base) = FakePushService::start().await;
    let push = PushSender::generate("mailto:test@example.com".into(), true).unwrap();
    let server = TestServer::start_with_push(pool, Some(push)).await;
    let (alice_dev, alice_token) = server.register("u5550006101.10").await;
    let (bob, bob_token) = server.register("u5550006102.10").await;
    server.admit(b"g", &[alice_dev, bob]).await;
    let sub =
        json!({ "endpoint": format!("{base}/push/bob"), "keys": { "p256dh": "P", "auth": "A" } });
    server
        .post("/v1/push/subscription", Some(&bob_token), sub)
        .await;

    // A receipt for offline Bob is queued but wakes nothing.
    let mut alice = server.connect(&alice_token).await;
    send_with(&mut alice, bob, true).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(service.count(), 0);
    send_with(&mut alice, bob, false).await;
    assert!(
        eventually(|| service.count() == 1).await,
        "a real message still pushes"
    );
}

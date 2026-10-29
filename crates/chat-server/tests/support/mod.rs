//! Shared helpers for database-backed server tests. These need a running
//! PostgreSQL: set DATABASE_URL (sqlx::test creates a fresh database per test).
#![allow(dead_code)]

use std::time::Duration;

use axum::{body::Body, http::Request};
use base64::{Engine, engine::general_purpose::STANDARD};
use chat_proto::v1::{Authenticate, ClientFrame, ServerFrame, client_frame, server_frame};
use chat_server::{AppState, router};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use prost::Message as _;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};
use tower::ServiceExt;
use uuid::Uuid;

pub struct TestServer {
    pub state: AppState,
    pub ws_url: String,
}

impl TestServer {
    pub async fn start(pool: PgPool) -> Self {
        Self::start_with_push(pool, None).await
    }

    pub async fn start_with_push(
        pool: PgPool,
        push: Option<chat_server::push::PushSender>,
    ) -> Self {
        Self::start_with(pool, push, chat_server::limits::Limits::default()).await
    }

    #[allow(dead_code)]
    pub async fn start_with_limits(pool: PgPool, limits: chat_server::limits::Limits) -> Self {
        Self::start_with(pool, None, limits).await
    }

    pub async fn start_with(
        pool: PgPool,
        push: Option<chat_server::push::PushSender>,
        limits: chat_server::limits::Limits,
    ) -> Self {
        // Open sign-up unless a test turns invites on (tests/invites.rs).
        let mut state = AppState::new(Some(pool))
            .with_blobs(std::sync::Arc::new(object_store::memory::InMemory::new()))
            .with_open_registration(true)
            .with_limits(limits);
        if let Some(push) = push {
            state = state.with_push(push);
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/ws", listener.local_addr().unwrap());
        let app = router(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await });
        Self { state, ws_url }
    }

    pub async fn put_json(&self, path: &str, token: &str, body: Value) -> (u16, Vec<u8>) {
        let req = Request::put(path)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json");
        let res = router(self.state.clone())
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, bytes.to_vec())
    }

    /// A request with a raw body; returns the raw response body.
    pub async fn raw(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Vec<u8>,
    ) -> (u16, Vec<u8>) {
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/octet-stream")
            .header("content-length", body.len());
        let res = router(self.state.clone())
            .oneshot(req.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, bytes.to_vec())
    }

    #[allow(dead_code)]
    pub async fn get(&self, path: &str, token: Option<&str>) -> (u16, Value) {
        let mut req = Request::get(path);
        if let Some(token) = token {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        let res = router(self.state.clone())
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    pub async fn post(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        self.post_with_headers(path, token, body, &[]).await
    }

    pub async fn post_with_headers(
        &self,
        path: &str,
        token: Option<&str>,
        body: Value,
        headers: &[(&str, &str)],
    ) -> (u16, Value) {
        let mut req = Request::post(path).header("content-type", "application/json");
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        if let Some(token) = token {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        let res = router(self.state.clone())
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            // Extractor rejections (e.g. 422) have plain-text bodies.
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        (status, json)
    }

    /// Makes devices members of a conversation directly (test setup).
    pub async fn admit(&self, conversation: &[u8], devices: &[Uuid]) {
        sqlx::query(
            "INSERT INTO conversation_members (conversation_id, device_id)
             SELECT $1, d FROM UNNEST($2::uuid[]) AS d ON CONFLICT DO NOTHING",
        )
        .bind(conversation)
        .bind(devices)
        .execute(self.state.db.as_ref().unwrap())
        .await
        .unwrap();
    }

    /// Signs up `username` (open registration); returns (device_id, token).
    pub async fn register(&self, username: &str) -> (Uuid, String) {
        let (status, body) = self
            .post(
                "/v1/register",
                None,
                json!({ "username": username, "identity_key": STANDARD.encode(b"test-identity-key") }),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        (
            body["device_id"].as_str().unwrap().parse().unwrap(),
            body["token"].as_str().unwrap().to_owned(),
        )
    }

    pub async fn connect(&self, token: &str) -> Client {
        let (ws, _) = tokio_tungstenite::connect_async(&self.ws_url)
            .await
            .unwrap();
        let mut client = Client::new(ws);
        let reply = client
            .request(client_frame::Body::Authenticate(Authenticate {
                token: token.to_owned(),
            }))
            .await;
        assert!(
            matches!(reply.body, Some(server_frame::Body::AuthResult(_))),
            "{reply:?}"
        );
        client
    }
}

pub struct Client {
    pub ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl Client {
    /// Whether the server closes this connection within 5 seconds.
    #[allow(dead_code)]
    pub async fn closed(&mut self) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Err(_) => return false,
                Ok(None | Some(Err(_)) | Some(Ok(Message::Close(_)))) => return true,
                Ok(Some(Ok(_))) => {}
            }
        }
    }

    /// Wraps a connection without authenticating.
    pub fn new(ws: WebSocketStream<MaybeTlsStream<TcpStream>>) -> Self {
        Self { ws, next_id: 1 }
    }

    pub async fn send_frame(&mut self, body: client_frame::Body) -> u64 {
        let request_id = self.next_id;
        self.next_id += 1;
        let frame = ClientFrame {
            request_id,
            body: Some(body),
        };
        self.ws
            .send(Message::Binary(frame.encode_to_vec().into()))
            .await
            .unwrap();
        request_id
    }

    /// Next binary frame from the server, or None after `timeout`.
    pub async fn next_frame(&mut self, timeout: Duration) -> Option<ServerFrame> {
        loop {
            let msg = tokio::time::timeout(timeout, self.ws.next())
                .await
                .ok()??
                .unwrap();
            if let Message::Binary(bytes) = msg {
                return Some(ServerFrame::decode(bytes).unwrap());
            }
        }
    }

    /// Sends a request and returns its reply, skipping pushed deliveries.
    pub async fn request(&mut self, body: client_frame::Body) -> ServerFrame {
        let id = self.send_frame(body).await;
        loop {
            let frame = self
                .next_frame(Duration::from_secs(5))
                .await
                .expect("reply");
            if frame.request_id == id {
                return frame;
            }
        }
    }
}

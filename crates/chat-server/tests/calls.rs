//! Group calls through LiveKit (ADR-0031).
mod support;

use axum::{Json, Router, http::HeaderMap, routing::post};
use base64::{Engine, engine::general_purpose::STANDARD};
use chat_server::{calls::LiveKitConfig, limits::Limits};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::TestServer;

const SECRET: &str = "a-secret-of-at-least-32-characters!";

/// A stand-in for LiveKit's RoomService: three people in any room asked
/// about, for callers with a room-list token.
async fn fake_livekit() -> String {
    async fn list_rooms(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        let token = headers["authorization"]
            .to_str()
            .unwrap()
            .trim_start_matches("Bearer ");
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&["key"]);
        let claims = decode::<Value>(
            token,
            &DecodingKey::from_secret(SECRET.as_bytes()),
            &validation,
        )
        .unwrap()
        .claims;
        assert_eq!(claims["video"]["roomList"], true);
        let name = body["names"][0].clone();
        Json(json!({ "rooms": [{ "name": name, "num_participants": 3 }] }))
    }
    let app = Router::new().route("/twirp/livekit.RoomService/ListRooms", post(list_rooms));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    url
}

fn request(conversation: &[u8]) -> Value {
    json!({ "conversation_id": STANDARD.encode(conversation), "call_id": STANDARD.encode([7u8; 16]) })
}

#[sqlx::test]
async fn group_calls_are_off_without_livekit(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("u5550007001.10").await;
    let (status, _) = server
        .post("/v1/calls/join", Some(&token), request(b"g"))
        .await;
    assert_eq!(status, 404);
}

#[sqlx::test]
async fn members_get_room_tokens_and_call_status(pool: PgPool) {
    let api = fake_livekit().await;
    let livekit = LiveKitConfig {
        url: Some("wss://rtc.example.com".into()),
        api_url: Some(api),
        api_key: "key".into(),
        api_secret: SECRET.into(),
    };
    let server = TestServer::start_with_livekit(pool, None, Limits::default(), livekit).await;
    let (member, token) = server.register("u5550007002.10").await;
    let (_, outsider) = server.register("u5550007003.10").await;
    server.admit(b"group-1", &[member]).await;

    let (status, _) = server
        .post("/v1/calls/join", None, request(b"group-1"))
        .await;
    assert_eq!(status, 401);
    let (status, _) = server
        .post("/v1/calls/join", Some(&outsider), request(b"group-1"))
        .await;
    assert_eq!(status, 403);
    let (status, _) = server
        .post(
            "/v1/calls/join",
            Some(&token),
            json!({ "conversation_id": "Zw==", "call_id": "AA==" }),
        )
        .await;
    assert_eq!(status, 400);

    let (status, body) = server
        .post("/v1/calls/join", Some(&token), request(b"group-1"))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["url"], "wss://rtc.example.com");
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["key"]);
    let claims = decode::<Value>(
        body["token"].as_str().unwrap(),
        &DecodingKey::from_secret(SECRET.as_bytes()),
        &validation,
    )
    .unwrap()
    .claims;
    assert_eq!(claims["sub"], member.simple().to_string());
    let room = chat_server::calls::room_name(b"group-1", &[7; 16]);
    assert_eq!(claims["video"]["room"], room);
    assert_eq!(claims["video"]["roomJoin"], true);
    assert_eq!(claims["video"]["canPublishData"], false);

    let (status, body) = server
        .post("/v1/calls/status", Some(&token), request(b"group-1"))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["participants"], 3);
    let (status, _) = server
        .post("/v1/calls/status", Some(&outsider), request(b"group-1"))
        .await;
    assert_eq!(status, 403);
}

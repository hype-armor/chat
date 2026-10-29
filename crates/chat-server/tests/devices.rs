//! Linked devices (ADR-0019).
mod support;

use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope, SendEnvelope, client_frame, server_frame},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::TestServer;
use uuid::Uuid;

fn key() -> String {
    STANDARD.encode(b"linked-device-key")
}

async fn link_code(server: &TestServer) -> String {
    let (status, body) = server.post("/v1/link/start", None, json!({})).await;
    assert_eq!(status, 200, "{body}");
    body["code"].as_str().unwrap().to_owned()
}

/// Links a new device to the account of `token`; returns (device, token).
async fn link(server: &TestServer, token: &str) -> (Uuid, String) {
    let code = link_code(server).await;
    let (status, _) = server
        .post("/v1/link/approve", Some(token), json!({ "code": code }))
        .await;
    assert_eq!(status, 204);
    let (status, body) = server
        .post(
            "/v1/link/complete",
            None,
            json!({ "code": code, "identity_key": key() }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    (
        body["device_id"].as_str().unwrap().parse().unwrap(),
        body["token"].as_str().unwrap().to_owned(),
    )
}

#[sqlx::test]
async fn linking_a_device_by_code(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("+15550006001").await;
    let account = |body: &Value| body["account_id"].as_str().unwrap().to_owned();
    let (_, me) = server
        .post(
            "/v1/lookup",
            Some(&token),
            json!({ "phone": "+15550006001" }),
        )
        .await;

    let code = link_code(&server).await;
    let complete = json!({ "code": code, "identity_key": key() });
    // Nothing happens until a signed-in device approves the code.
    let (status, _) = server
        .post("/v1/link/complete", None, complete.clone())
        .await;
    assert_eq!(status, 409);
    let (status, _) = server
        .post("/v1/link/approve", None, json!({ "code": code }))
        .await;
    assert_eq!(status, 401);
    let (status, _) = server
        .post("/v1/link/approve", Some(&token), json!({ "code": code }))
        .await;
    assert_eq!(status, 204);
    let (status, _) = server
        .post("/v1/link/approve", Some(&token), json!({ "code": code }))
        .await;
    assert_eq!(status, 409, "approving twice");
    let (_, body) = server
        .post("/v1/link/status", Some(&token), json!({ "code": code }))
        .await;
    assert_eq!(body["device_id"], Value::Null);

    let (status, linked) = server
        .post("/v1/link/complete", None, complete.clone())
        .await;
    assert_eq!(status, 200, "{linked}");
    assert_eq!(account(&linked), account(&me));
    assert_eq!(linked["phone"], "+15550006001");
    let (_, body) = server
        .post("/v1/link/status", Some(&token), json!({ "code": code }))
        .await;
    assert_eq!(body["device_id"], linked["device_id"]);
    // A code links one device only.
    let (status, _) = server.post("/v1/link/complete", None, complete).await;
    assert_eq!(status, 404);

    // Another account cannot see the link.
    let (_, other) = server.register("+15550006002").await;
    let (status, _) = server
        .post("/v1/link/status", Some(&other), json!({ "code": code }))
        .await;
    assert_eq!(status, 404);

    // Expired and malformed codes.
    let code = link_code(&server).await;
    sqlx::query("UPDATE link_requests SET expires_at = now() - interval '1 second'")
        .execute(server.state.db.as_ref().unwrap())
        .await
        .unwrap();
    let (status, _) = server
        .post("/v1/link/approve", Some(&token), json!({ "code": code }))
        .await;
    assert_eq!(status, 404);
    let (status, _) = server
        .post("/v1/link/approve", Some(&token), json!({ "code": "nope" }))
        .await;
    assert_eq!(status, 400);
}

#[sqlx::test]
async fn listing_and_removing_devices(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (first, token) = server.register("+15550006011").await;
    let (second, second_token) = link(&server, &token).await;
    let (stranger, stranger_token) = server.register("+15550006012").await;

    let (_, body) = server.get("/v1/devices", Some(&token)).await;
    let devices = body["devices"].as_array().unwrap();
    let ids: Vec<&str> = devices
        .iter()
        .map(|d| d["device_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [first.to_string(), second.to_string()]);
    assert_eq!(devices[0]["current"], true);
    assert_eq!(devices[1]["current"], false);
    assert!(devices[0]["added_on"].as_str().unwrap().len() == 10);

    let remove = |id: Uuid| json!({ "device_id": id });
    let (status, _) = server
        .post("/v1/devices/remove", Some(&token), remove(first))
        .await;
    assert_eq!(status, 400, "not this device");
    let (status, _) = server
        .post("/v1/devices/remove", Some(&stranger_token), remove(second))
        .await;
    assert_eq!(status, 404, "not someone else's");

    // A removed device's open connection closes and its token stops working.
    let mut ws = server.connect(&second_token).await;
    let (status, _) = server
        .post("/v1/devices/remove", Some(&token), remove(second))
        .await;
    assert_eq!(status, 204);
    assert!(ws.closed().await, "socket of the removed device stays open");
    let (status, _) = server.get("/v1/devices", Some(&second_token)).await;
    assert_eq!(status, 401);
    let (_, body) = server.get("/v1/devices", Some(&token)).await;
    assert_eq!(body["devices"].as_array().unwrap().len(), 1);
    let _ = stranger;
}

#[sqlx::test]
async fn sends_skip_removed_devices(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (alice, alice_token) = server.register("+15550006021").await;
    let (bob, bob_token) = server.register("+15550006022").await;
    let (bob2, _) = link(&server, &bob_token).await;
    server.admit(b"c", &[alice, bob, bob2]).await;
    let (status, _) = server
        .post(
            "/v1/devices/remove",
            Some(&bob_token),
            json!({ "device_id": bob2 }),
        )
        .await;
    assert_eq!(status, 204);

    // Alice hasn't seen the removal commit yet and still sends to bob2.
    let mut a = server.connect(&alice_token).await;
    let mut b = server.connect(&bob_token).await;
    let send = |content_type: ContentType| {
        client_frame::Body::Send(SendEnvelope {
            envelope: Some(Envelope {
                version: PROTOCOL_VERSION,
                conversation_id: b"c".to_vec(),
                epoch: 0,
                content_type: content_type.into(),
                ciphertext: b"x".to_vec(),
                message_id: Uuid::new_v4().as_bytes().to_vec(),
            }),
            recipient_devices: vec![bob.as_bytes().to_vec(), bob2.as_bytes().to_vec()],
            ..Default::default()
        })
    };
    match a.request(send(ContentType::Application)).await.body {
        Some(server_frame::Body::SendResult(r)) => assert!(r.accepted),
        other => panic!("{other:?}"),
    }
    let frame = b
        .next_frame(Duration::from_secs(5))
        .await
        .expect("delivery");
    assert!(matches!(frame.body, Some(server_frame::Body::Deliver(_))));
    // Welcomes must still go to real devices.
    match a.request(send(ContentType::Welcome)).await.body {
        Some(server_frame::Body::Error(e)) => assert_eq!(e.code, 400),
        other => panic!("{other:?}"),
    }
}

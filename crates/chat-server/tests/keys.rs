//! Key-package counts for replenishment (roadmap item 14).
mod support;

use base64::{Engine, engine::general_purpose::STANDARD};
use chat_proto::v1::{Authenticate, client_frame, server_frame};
use serde_json::json;
use sqlx::PgPool;
use support::{Client, TestServer};
use uuid::Uuid;

#[sqlx::test]
async fn devices_learn_how_many_key_packages_they_have_left(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (device, token) = server.register("u5550003001.10").await;
    let count = |token: String| {
        let server = &server;
        async move {
            server.get("/v1/keys/count", Some(&token)).await.1["available"]
                .as_u64()
                .unwrap()
        }
    };
    assert_eq!(count(token.clone()).await, 0);

    let kps: Vec<String> = (0..3)
        .map(|_| STANDARD.encode(Uuid::new_v4().as_bytes()))
        .collect();
    let (status, _) = server
        .post("/v1/keys", Some(&token), json!({ "key_packages": kps }))
        .await;
    assert_eq!(status, 204);
    assert_eq!(count(token.clone()).await, 3);

    // One about to expire no longer counts.
    sqlx::query(
        "UPDATE key_packages SET expires_at = now() + interval '1 day'
         WHERE key_package_id = (SELECT min(key_package_id) FROM key_packages WHERE device_id = $1)",
    )
    .bind(device)
    .execute(server.state.db.as_ref().unwrap())
    .await
    .unwrap();
    assert_eq!(count(token.clone()).await, 2);

    // The WebSocket reports it on authentication too.
    let (ws, _) = tokio_tungstenite::connect_async(&server.ws_url)
        .await
        .unwrap();
    let mut client = Client::new(ws);
    let reply = client
        .request(client_frame::Body::Authenticate(Authenticate { token }))
        .await;
    match reply.body {
        Some(server_frame::Body::AuthResult(a)) => assert_eq!(a.key_packages, 2),
        other => panic!("{other:?}"),
    }
}

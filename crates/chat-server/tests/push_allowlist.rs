//! A push subscription endpoint is user-chosen data: the server stores only
//! endpoints that point at a known push service, so it cannot be used as a
//! request forwarder into its own network (FR-NOT-1/2).
mod support;

use chat_server::push::PushSender;
use serde_json::json;
use sqlx::PgPool;
use support::TestServer;

fn subscription(endpoint: &str) -> serde_json::Value {
    json!({
        "endpoint": endpoint,
        "keys": { "p256dh": "BExample", "auth": "example" },
    })
}

#[sqlx::test]
async fn subscriptions_must_point_at_a_known_push_service(pool: PgPool) {
    // Production configuration: no plain HTTP endpoints, default allowlist.
    let push = PushSender::generate("mailto:test@example.com".into(), false).unwrap();
    let server = TestServer::start_with_push(pool, Some(push)).await;
    let (_, token) = server.register("u5550009101.10").await;

    // A loopback address would turn the server into an internal scanner.
    let (status, body) = server
        .post(
            "/v1/push/subscription",
            Some(&token),
            subscription("https://127.0.0.1:9/push"),
        )
        .await;
    assert_eq!(status, 400, "{body}");

    // The real Chrome push service is allowed.
    let (status, body) = server
        .post(
            "/v1/push/subscription",
            Some(&token),
            subscription("https://fcm.googleapis.com/fcm/send/abc"),
        )
        .await;
    assert_eq!(status, 204, "{body}");

    // A lookalike host (suffix of an allowed name plus junk) is not.
    let (status, body) = server
        .post(
            "/v1/push/subscription",
            Some(&token),
            subscription("https://fcm.googleapis.com.evil.example/x"),
        )
        .await;
    assert_eq!(status, 400, "{body}");
}

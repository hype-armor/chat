//! ICE servers for calls (ADR-0028).
mod support;

use sqlx::PgPool;
use support::TestServer;

#[sqlx::test]
async fn ice_servers_need_a_signed_in_device(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (status, _) = server.get("/v1/turn", None).await;
    assert_eq!(status, 401);
    let (_, token) = server.register("u5550006001.10").await;
    let (status, body) = server.get("/v1/turn", Some(&token)).await;
    assert_eq!(status, 200);
    // None configured in tests: calls fall back to host candidates.
    assert_eq!(body["ice_servers"], serde_json::json!([]));
    assert!(body["ttl"].as_u64().unwrap() > 3600);
}

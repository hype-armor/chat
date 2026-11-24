//! Authoritative account identity is scoped to the authenticated device.
mod support;

use axum::{body::Body, http::Request};
use chat_server::router;
use http_body_util::BodyExt;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use support::TestServer;
use tower::ServiceExt;
use uuid::Uuid;

#[sqlx::test]
async fn current_account_uses_live_account_row_for_each_device(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (first, first_token) = server.register("alice.40").await;
    let (_, other_token) = server.register("bob.40").await;
    let db = server.state.db.as_ref().unwrap();
    let second_token = "linked-device-token";
    sqlx::query(
        "INSERT INTO devices (device_id, account_id, identity_key, auth_token_hash)
         SELECT $1, account_id, $2, $3 FROM devices WHERE device_id = $4",
    )
    .bind(Uuid::new_v4())
    .bind(b"linked-key".as_slice())
    .bind(Sha256::digest(second_token.as_bytes()).to_vec())
    .bind(first)
    .execute(db)
    .await
    .unwrap();

    let (_, before) = server.get("/v1/account", Some(&first_token)).await;
    assert_eq!(before["username"], "alice.40");
    // This direct update only models a stale client. No rename API exists yet.
    sqlx::query("UPDATE accounts SET username = 'alice.41' WHERE account_id = $1")
        .bind(Uuid::parse_str(before["account_id"].as_str().unwrap()).unwrap())
        .execute(db)
        .await
        .unwrap();
    let (_, linked) = server.get("/v1/account", Some(second_token)).await;
    assert_eq!(linked["account_id"], before["account_id"]);
    assert_eq!(linked["username"], "alice.41");
    let (_, other) = server.get("/v1/account", Some(&other_token)).await;
    assert_ne!(other["account_id"], before["account_id"]);
    assert_eq!(other["username"], "bob.40");
    assert_eq!(server.get("/v1/account", None).await.0, 401);

    let response = router(server.state.clone())
        .oneshot(
            Request::get("/v1/account")
                .header("authorization", format!("Bearer {first_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["username"], "alice.41");
}

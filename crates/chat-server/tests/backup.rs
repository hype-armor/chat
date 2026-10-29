//! Encrypted backups and restore (ADR-0022).
mod support;

use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use chat_proto::v1::server_frame;
use chat_server::limits::Limits;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use support::TestServer;

fn auth_secret(seed: u8) -> (String, String) {
    let secret = [seed; 32];
    (
        STANDARD.encode(secret),
        STANDARD.encode(Sha256::digest(secret)),
    )
}

#[sqlx::test]
async fn backing_up_and_restoring_onto_a_new_device(pool: PgPool) {
    let server = TestServer::start_with_limits(
        pool,
        Limits {
            restores_per_account_per_day: 3,
            ..Limits::default()
        },
    )
    .await;
    let (alice, alice_token) = server.register("alice.01").await;
    let (bob, bob_token) = server.register("bob.01").await;
    server.admit(b"c", &[alice, bob]).await;
    let (secret, hash) = auth_secret(7);

    // A recovery key comes first; backups can be larger than JSON bodies.
    let blob = vec![42u8; 3 * 1024 * 1024];
    assert_eq!(
        server
            .raw("PUT", "/v1/backup", &alice_token, blob.clone())
            .await
            .0,
        409
    );
    let (status, _) = server
        .put_json("/v1/backup/key", &alice_token, json!({ "auth_hash": hash }))
        .await;
    assert_eq!(status, 204);
    assert_eq!(
        server
            .raw("PUT", "/v1/backup", &alice_token, blob.clone())
            .await
            .0,
        204
    );
    let (status, fetched) = server.raw("GET", "/v1/backup", &alice_token, vec![]).await;
    assert_eq!((status, fetched.len()), (200, blob.len()));

    // Wrong key or unknown username: the same refusal.
    let restore = |username: &str, auth: &str| json!({ "username": username, "auth": auth, "identity_key": STANDARD.encode(b"new") });
    let (wrong, _) = auth_secret(8);
    assert_eq!(
        server
            .post("/v1/backup/restore", None, restore("alice.01", &wrong))
            .await
            .0,
        401
    );
    assert_eq!(
        server
            .post("/v1/backup/restore", None, restore("nobody.01", &secret))
            .await
            .0,
        401
    );

    // Restoring replaces Alice's devices; Bob's open session hears about it.
    let mut old = server.connect(&alice_token).await;
    let mut bob_ws = server.connect(&bob_token).await;
    let (status, restored) = server
        .post("/v1/backup/restore", None, restore("Alice.01", &secret))
        .await;
    assert_eq!(status, 200, "{restored}");
    assert_eq!(restored["username"], "alice.01");
    let token = restored["token"].as_str().unwrap();
    assert!(old.closed().await, "the old device is signed out");
    assert_eq!(server.get("/v1/devices", Some(&alice_token)).await.0, 401);
    let (_, devices) = server.get("/v1/devices", Some(token)).await;
    assert_eq!(devices["devices"].as_array().unwrap().len(), 1);
    let frame = bob_ws
        .next_frame(Duration::from_secs(5))
        .await
        .expect("notice");
    assert!(
        matches!(frame.body, Some(server_frame::Body::DevicesChanged(_))),
        "{frame:?}"
    );
    let (status, fetched) = server.raw("GET", "/v1/backup", token, vec![]).await;
    assert_eq!((status, fetched), (200, blob));

    // Attempts per account are limited, right or wrong.
    assert_eq!(
        server
            .post("/v1/backup/restore", None, restore("alice.01", &secret))
            .await
            .0,
        200
    );
    assert_eq!(
        server
            .post("/v1/backup/restore", None, restore("alice.01", &secret))
            .await
            .0,
        429
    );
}

#[sqlx::test]
async fn new_key_drops_the_old_backup_and_backups_can_be_deleted(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let (_, hash) = auth_secret(1);
    server
        .put_json("/v1/backup/key", &token, json!({ "auth_hash": hash }))
        .await;
    assert_eq!(
        server
            .raw("PUT", "/v1/backup", &token, vec![1, 2, 3])
            .await
            .0,
        204
    );
    let (_, other) = auth_secret(2);
    server
        .put_json("/v1/backup/key", &token, json!({ "auth_hash": other }))
        .await;
    assert_eq!(server.raw("GET", "/v1/backup", &token, vec![]).await.0, 404);
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, vec![4]).await.0,
        204
    );
    assert_eq!(
        server
            .post("/v1/backup/delete", Some(&token), json!({}))
            .await
            .0,
        204
    );
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, vec![5]).await.0,
        409
    );
}

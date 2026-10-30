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

/// Backup objects in the blob store.
async fn stored_backups(server: &TestServer) -> Vec<String> {
    use futures_util::TryStreamExt;
    let store = server.state.blobs.clone().unwrap();
    let prefix = object_store::path::Path::from("backups");
    let mut keys: Vec<String> = store
        .list(Some(&prefix))
        .map_ok(|m| m.location.to_string())
        .try_collect()
        .await
        .unwrap();
    keys.sort();
    keys
}

#[sqlx::test]
async fn backups_live_in_the_blob_store_and_leave_with_the_account(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let (_, hash) = auth_secret(1);
    server
        .put_json("/v1/backup/key", &token, json!({ "auth_hash": hash }))
        .await;

    // Bigger than the old 25 MB cap; a new upload replaces the old object.
    let big: Vec<u8> = (0..30 * 1024 * 1024).map(|i| (i % 249) as u8).collect();
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, big.clone()).await.0,
        204
    );
    let first = stored_backups(&server).await;
    assert_eq!(first.len(), 1);
    let (status, fetched) = server.raw("GET", "/v1/backup", &token, vec![]).await;
    assert_eq!(status, 200);
    assert!(fetched == big);
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, vec![9; 10]).await.0,
        204
    );
    let second = stored_backups(&server).await;
    assert_eq!(second.len(), 1);
    assert_ne!(first, second);
    assert_eq!(
        server.raw("GET", "/v1/backup", &token, vec![]).await.1,
        vec![9; 10]
    );

    // A new recovery key drops it; so does turning backups off.
    let (_, other) = auth_secret(2);
    server
        .put_json("/v1/backup/key", &token, json!({ "auth_hash": other }))
        .await;
    assert!(stored_backups(&server).await.is_empty());
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, vec![1]).await.0,
        204
    );
    server
        .post("/v1/backup/delete", Some(&token), json!({}))
        .await;
    assert!(stored_backups(&server).await.is_empty());

    // Deleting the account deletes its backup.
    server
        .put_json("/v1/backup/key", &token, json!({ "auth_hash": hash }))
        .await;
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, vec![2]).await.0,
        204
    );
    assert_eq!(stored_backups(&server).await.len(), 1);
    let (status, _) = server
        .post(
            "/v1/account/delete",
            Some(&token),
            json!({ "username": "ann.01" }),
        )
        .await;
    assert_eq!(status, 204);
    assert!(stored_backups(&server).await.is_empty());
}

#[sqlx::test]
async fn backups_kept_in_postgres_move_to_the_blob_store(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let (_, hash) = auth_secret(1);
    server
        .put_json("/v1/backup/key", &token, json!({ "auth_hash": hash }))
        .await;
    // As stored before migration 0010.
    let db = server.state.db.clone().unwrap();
    sqlx::query("UPDATE backups SET blob = $1")
        .bind(vec![7u8; 100])
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(server.raw("GET", "/v1/backup", &token, vec![]).await.0, 404);
    let store = server.state.blobs.clone().unwrap();
    chat_server::backup::move_to_store(&db, &store)
        .await
        .unwrap();
    chat_server::backup::move_to_store(&db, &store)
        .await
        .unwrap();
    assert_eq!(stored_backups(&server).await.len(), 1);
    let (status, fetched) = server.raw("GET", "/v1/backup", &token, vec![]).await;
    assert_eq!(status, 200);
    assert_eq!(fetched, vec![7u8; 100]);
    let (left,): (i64,) = sqlx::query_as("SELECT count(*) FROM backups WHERE blob IS NOT NULL")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

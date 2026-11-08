//! Account deletion (FR-ID-9).
mod support;

use object_store::ObjectStoreExt;
use serde_json::json;
use sqlx::PgPool;
use support::TestServer;

#[sqlx::test]
async fn deleting_an_account_removes_its_server_data(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let username = "alice.40";
    let (alice, token) = server.register(username).await;
    let (bob, bob_token) = server.register("u5550004002.10").await;
    server.admit(b"c", &[alice, bob]).await;
    let (_, me) = server
        .post(
            "/v1/lookup",
            Some(&bob_token),
            json!({ "username": username }),
        )
        .await;
    let report = json!({ "account_id": me["account_id"], "reason": "spam" });
    assert_eq!(
        server.post("/v1/reports", Some(&bob_token), report).await.0,
        204
    );
    let mut ws = server.connect(&token).await;

    // A finished backup must release its charge after account deletion.
    use base64::{Engine, engine::general_purpose::STANDARD};
    assert_eq!(
        server
            .put_json(
                "/v1/backup/key",
                &token,
                json!({"auth_hash": STANDARD.encode([7; 32])})
            )
            .await
            .0,
        204
    );
    assert_eq!(
        server
            .raw("PUT", "/v1/backup", &token, vec![42; 100])
            .await
            .0,
        204
    );
    let (backup_key,): (String,) = sqlx::query_as(
        "SELECT object_key FROM backups WHERE account_id = (SELECT account_id FROM devices WHERE device_id = $1)",
    )
    .bind(alice)
    .fetch_one(server.state.db.as_ref().unwrap())
    .await
    .unwrap();

    // The username must be typed again.
    let (status, _) = server
        .post(
            "/v1/account/delete",
            Some(&token),
            json!({ "username": "u5550000000.10" }),
        )
        .await;
    assert_eq!(status, 400);
    let (status, _) = server
        .post(
            "/v1/account/delete",
            Some(&token),
            json!({ "username": username }),
        )
        .await;
    assert_eq!(status, 204);

    let db = server.state.db.as_ref().unwrap();
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM accounts WHERE username = $1")
        .bind(username)
        .fetch_one(db)
        .await
        .unwrap();
    assert_eq!(n, 0, "accounts");
    let charged: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM storage_objects WHERE object_key = $1)")
            .bind(&backup_key)
            .fetch_one(db)
            .await
            .unwrap();
    assert!(
        !charged,
        "deleted backup must not retain a global quota charge"
    );
    assert!(
        server
            .state
            .blobs
            .as_ref()
            .unwrap()
            .head(&object_store::path::Path::from(backup_key))
            .await
            .is_err()
    );
    for table in [
        "devices",
        "conversation_members",
        "key_packages",
        "queued_envelopes",
    ] {
        let column = if table == "queued_envelopes" {
            "recipient_device_id"
        } else {
            "device_id"
        };
        let (n,): (i64,) =
            sqlx::query_as(&format!("SELECT count(*) FROM {table} WHERE {column} = $1"))
                .bind(alice)
                .fetch_one(db)
                .await
                .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    let (reports,): (i64,) = sqlx::query_as("SELECT count(*) FROM reports")
        .fetch_one(db)
        .await
        .unwrap();
    assert_eq!(reports, 0);

    // Its token stops working and its socket closes; the username is free again.
    assert_eq!(server.get("/v1/devices", Some(&token)).await.0, 401);
    assert!(ws.closed().await, "socket stays open");
    let (again, _) = server.register(username).await;
    assert_ne!(again, alice);
}

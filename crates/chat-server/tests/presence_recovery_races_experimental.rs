//! Isolated PostgreSQL tests for experimental presence races and recovery.
mod support;

use base64::{Engine, engine::general_purpose::STANDARD};
use chat_server::presence::{self, Error};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use support::TestServer;
use uuid::Uuid;

async fn account(pool: &PgPool) -> (Uuid, Uuid, String) {
    let account = Uuid::new_v4();
    let device = Uuid::new_v4();
    let token = device.to_string();
    sqlx::query("INSERT INTO accounts (account_id, username) VALUES ($1, $2)")
        .bind(account)
        .bind(account.to_string())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO devices (device_id, account_id, identity_key, auth_token_hash) VALUES ($1, $2, $3, $4)")
        .bind(device).bind(account).bind(vec![1_u8])
        .bind(Sha256::digest(token.as_bytes()).to_vec()).execute(pool).await.unwrap();
    (account, device, token)
}

#[sqlx::test(migrations = "./migrations")]
async fn concurrent_grant_changes_have_one_winner_and_retry_conflicts(pool: PgPool) {
    let (sender, device, token) = account(&pool).await;
    let (first, _, _) = account(&pool).await;
    let (second, _, _) = account(&pool).await;
    let (a, b) = tokio::join!(
        presence::set_grant(&pool, device, &token, first, 0, true),
        presence::set_grant(&pool, device, &token, second, 0, true)
    );
    let winner = match (a, b) {
        (Ok(1), Err(Error::Conflict)) => first,
        (Err(Error::Conflict), Ok(1)) => second,
        other => panic!("unexpected results: {other:?}"),
    };
    // A client that lost the response cannot replay the old expected version.
    assert!(matches!(
        presence::set_grant(&pool, device, &token, winner, 0, true).await,
        Err(Error::Conflict)
    ));
    let rows: Vec<(Uuid, i64)> =
        sqlx::query_as("SELECT recipient, generation FROM presence_grants WHERE sender=$1")
            .bind(sender)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows, vec![(winner, 1)]);
    let version: i64 =
        sqlx::query_scalar("SELECT version FROM presence_versions WHERE account_id=$1")
            .bind(sender)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(version, 1);
    assert_eq!(
        presence::set_grant(&pool, device, &token, winner, version, false)
            .await
            .unwrap(),
        2
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn restore_removes_old_device_leases_but_keeps_account_grant(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (old_device, old_token) = server.register("presence_restore.42").await;
    let (recipient_device, recipient_token) = server.register("presence_recipient.42").await;
    let sender: Uuid = sqlx::query_scalar("SELECT account_id FROM devices WHERE device_id=$1")
        .bind(old_device)
        .fetch_one(&pool)
        .await
        .unwrap();
    let recipient: Uuid = sqlx::query_scalar("SELECT account_id FROM devices WHERE device_id=$1")
        .bind(recipient_device)
        .fetch_one(&pool)
        .await
        .unwrap();
    presence::set_grant(&pool, old_device, &old_token, recipient, 0, true)
        .await
        .unwrap();
    presence::publish(
        &pool,
        old_device,
        &old_token,
        recipient,
        1,
        b"old ciphertext",
    )
    .await
    .unwrap();
    let secret = [7_u8; 32];
    assert_eq!(
        server
            .put_json(
                "/v1/backup/key",
                &old_token,
                json!({"auth_hash": STANDARD.encode(Sha256::digest(secret))})
            )
            .await
            .0,
        204
    );
    let (status, restored) = server.post("/v1/backup/restore", None, json!({
        "username": "presence_restore.42", "auth": STANDARD.encode(secret), "identity_key": STANDARD.encode(b"new")
    })).await;
    assert_eq!(status, 200, "{restored}");
    let new_token = restored["token"].as_str().unwrap();
    let new_device: Uuid = sqlx::query_scalar("SELECT device_id FROM devices WHERE account_id=$1")
        .bind(sender)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_ne!(new_device, old_device);
    assert!(matches!(
        presence::publish(&pool, old_device, &old_token, recipient, 1, b"stale").await,
        Err(Error::Unauthorized)
    ));
    assert!(
        presence::poll(&pool, recipient_device, &recipient_token, sender)
            .await
            .unwrap()
            .is_empty()
    );
    // Grants are account-scoped in the current experimental store, while leases are device-scoped.
    presence::publish(
        &pool,
        new_device,
        new_token,
        recipient,
        1,
        b"new ciphertext",
    )
    .await
    .unwrap();
    assert_eq!(
        presence::poll(&pool, recipient_device, &recipient_token, sender)
            .await
            .unwrap(),
        vec![(new_device, 1, b"new ciphertext".to_vec())]
    );
}

use sha2::{Digest, Sha256};
fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}
use chat_server::presence::{self, Error};
use sqlx::PgPool;
use uuid::Uuid;

async fn account(pool: &PgPool) -> (Uuid, Uuid, String) {
    let account = Uuid::new_v4();
    let device = Uuid::new_v4();
    let token = device.to_string();
    sqlx::query("INSERT INTO accounts (account_id,username) VALUES ($1,$2)")
        .bind(account)
        .bind(account.to_string())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO devices (device_id,account_id,identity_key,auth_token_hash) VALUES ($1,$2,$3,$4)")
        .bind(device).bind(account).bind(vec![1_u8]).bind(token_hash(&token)).execute(pool).await.unwrap();
    (account, device, token)
}

#[sqlx::test(migrations = "./migrations")]
async fn token_binding_and_rejected_attempts(pool: PgPool) {
    let (_, a, token) = account(&pool).await;
    let (recipient, _, other_token) = account(&pool).await;
    assert!(matches!(
        presence::set_grant(&pool, a, &other_token, recipient, 0, true).await,
        Err(Error::Unauthorized)
    ));
    for _ in 0..120 {
        assert!(matches!(
            presence::publish(&pool, a, &token, recipient, 1, b"x").await,
            Err(Error::Unauthorized)
        ));
    }
    assert!(matches!(
        presence::set_grant(&pool, a, &token, recipient, 0, true).await,
        Err(Error::Limited)
    ));
    sqlx::query("UPDATE devices SET auth_token_hash=$2 WHERE device_id=$1")
        .bind(a)
        .bind(token_hash("rotated"))
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        presence::poll(&pool, a, &token, recipient).await,
        Err(Error::Unauthorized)
    ));
}

#[sqlx::test(migrations = "./migrations")]
async fn purge_keeps_live_and_device_deletion_removes_lease(pool: PgPool) {
    let (sender, a, token) = account(&pool).await;
    let (recipient, b, btoken) = account(&pool).await;
    presence::set_grant(&pool, a, &token, recipient, 0, true)
        .await
        .unwrap();
    presence::publish(&pool, a, &token, recipient, 1, b"live")
        .await
        .unwrap();
    assert_eq!(presence::purge_expired(&pool).await.unwrap(), 0);
    assert_eq!(
        presence::poll(&pool, b, &btoken, sender)
            .await
            .unwrap()
            .len(),
        1
    );
    sqlx::query("UPDATE presence_leases SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(presence::purge_expired(&pool).await.unwrap(), 1);
    presence::publish(&pool, a, &token, recipient, 1, b"new")
        .await
        .unwrap();
    sqlx::query("DELETE FROM devices WHERE device_id=$1")
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        presence::poll(&pool, b, &btoken, sender)
            .await
            .unwrap()
            .is_empty()
    );
}

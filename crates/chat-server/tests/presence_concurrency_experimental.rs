use chat_server::presence::{self, Error};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

async fn account(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (account_id,username) VALUES ($1,$2)")
        .bind(id)
        .bind(id.to_string())
        .execute(pool)
        .await
        .unwrap();
    id
}
async fn device(pool: &PgPool, account: Uuid) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let token = id.to_string();
    sqlx::query("INSERT INTO devices (device_id,account_id,identity_key,auth_token_hash) VALUES ($1,$2,$3,$4)")
        .bind(id).bind(account).bind(vec![1_u8]).bind(Sha256::digest(token.as_bytes()).to_vec()).execute(pool).await.unwrap();
    (id, token)
}

#[sqlx::test(migrations = "./migrations")]
async fn lease_count_is_bounded_under_concurrent_publish(pool: PgPool) {
    let sender = account(&pool).await;
    let recipient = account(&pool).await;
    let (first, token) = device(&pool, sender).await;
    presence::set_grant(&pool, first, &token, recipient, 0, true)
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for _ in 0..12 {
        let (id, token) = device(&pool, sender).await;
        let db = pool.clone();
        tasks.push(tokio::spawn(async move {
            presence::publish(&db, id, &token, recipient, 1, b"cipher").await
        }));
    }
    let mut successes = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(()) => successes += 1,
            Err(Error::Limited) => (),
            other => panic!("unexpected: {other:?}"),
        }
    }
    assert_eq!(successes, 10);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM presence_leases WHERE sender=$1 AND recipient=$2")
            .bind(sender)
            .bind(recipient)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 10);
}

#[sqlx::test(migrations = "./migrations")]
async fn audience_is_bounded(pool: PgPool) {
    let sender = account(&pool).await;
    let (id, token) = device(&pool, sender).await;
    for version in 0..100 {
        let recipient = account(&pool).await;
        assert_eq!(
            presence::set_grant(&pool, id, &token, recipient, version, true)
                .await
                .unwrap(),
            version + 1
        );
    }
    let recipient = account(&pool).await;
    assert!(matches!(
        presence::set_grant(&pool, id, &token, recipient, 100, true).await,
        Err(Error::Limited)
    ));
}

#[sqlx::test(migrations = "./migrations")]
async fn token_revoked_before_authorization_cannot_poll(pool: PgPool) {
    let sender = account(&pool).await;
    let recipient = account(&pool).await;
    let (id, token) = device(&pool, recipient).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE devices SET auth_token_hash=NULL WHERE device_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let db = pool.clone();
    let task = tokio::spawn(async move { presence::poll(&db, id, &token, sender).await });
    tx.commit().await.unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::Unauthorized)));
}

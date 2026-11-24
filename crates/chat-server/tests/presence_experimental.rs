use sha2::{Digest, Sha256};
fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}
use chat_server::presence::{self, Error};
use sqlx::PgPool;
use uuid::Uuid;

async fn account(pool: &PgPool) -> (Uuid, Uuid) {
    let account = Uuid::new_v4();
    let device = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (account_id,username) VALUES ($1,$2)")
        .bind(account)
        .bind(account.to_string())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO devices (device_id,account_id,identity_key,auth_token_hash) VALUES ($1,$2,$3,$4)")
        .bind(device).bind(account).bind(vec![1_u8]).bind(token_hash(&device.to_string())).execute(pool).await.unwrap();
    (account, device)
}

#[sqlx::test(migrations = "./migrations")]
async fn grants_revoke_regrant_and_device_removal(pool: PgPool) {
    let (alice, a) = account(&pool).await;
    let (bob, b) = account(&pool).await;
    assert!(
        presence::poll(&pool, b, &b.to_string(), alice)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        presence::publish(&pool, a, &a.to_string(), bob, 1, b"cipher").await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(
        presence::set_grant(&pool, a, &a.to_string(), bob, 0, true)
            .await
            .unwrap(),
        1
    );
    assert!(matches!(
        presence::set_grant(&pool, a, &a.to_string(), bob, 0, true).await,
        Err(Error::Conflict)
    ));
    presence::publish(&pool, a, &a.to_string(), bob, 1, b"cipher")
        .await
        .unwrap();
    assert_eq!(
        presence::poll(&pool, b, &b.to_string(), alice)
            .await
            .unwrap(),
        vec![(a, 1, b"cipher".to_vec())]
    );
    assert_eq!(
        presence::set_grant(&pool, a, &a.to_string(), bob, 1, false)
            .await
            .unwrap(),
        2
    );
    assert!(
        presence::poll(&pool, b, &b.to_string(), alice)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        presence::set_grant(&pool, a, &a.to_string(), bob, 2, true)
            .await
            .unwrap(),
        3
    );
    assert!(
        presence::poll(&pool, b, &b.to_string(), alice)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        presence::publish(&pool, a, &a.to_string(), bob, 1, b"old").await,
        Err(Error::Unauthorized)
    ));
    presence::publish(&pool, a, &a.to_string(), bob, 3, b"new")
        .await
        .unwrap();
    sqlx::query("DELETE FROM devices WHERE device_id=$1")
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        presence::poll(&pool, b, &b.to_string(), alice)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        presence::set_grant(&pool, a, &a.to_string(), bob, 3, true).await,
        Err(Error::Unauthorized)
    ));
    sqlx::query("DELETE FROM accounts WHERE account_id=$1")
        .bind(alice)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        presence::poll(&pool, b, &b.to_string(), alice)
            .await
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn concurrent_polls_and_revocation(pool: PgPool) {
    let (alice, a) = account(&pool).await;
    let (bob, b) = account(&pool).await;
    presence::set_grant(&pool, a, &a.to_string(), bob, 0, true)
        .await
        .unwrap();
    presence::publish(&pool, a, &a.to_string(), bob, 1, b"cipher")
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for _ in 0..20 {
        let db = pool.clone();
        tasks.push(tokio::spawn(async move {
            presence::poll(&db, b, &b.to_string(), alice).await.unwrap()
        }));
    }
    presence::set_grant(&pool, a, &a.to_string(), bob, 1, false)
        .await
        .unwrap();
    for task in tasks {
        let result = task.await.unwrap();
        assert!(result.is_empty() || result == vec![(a, 1, b"cipher".to_vec())]);
    }
    for _ in 0..10 {
        assert!(
            presence::poll(&pool, b, &b.to_string(), alice)
                .await
                .unwrap()
                .is_empty()
        );
    }
}

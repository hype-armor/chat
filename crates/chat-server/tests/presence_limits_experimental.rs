use sha2::{Digest, Sha256};
fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}
use chat_server::presence::{self, Error};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = "./migrations")]
async fn bounded_payload_expiry_and_poll_limit(pool: PgPool) {
    let (sender, recipient, a, b) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    for id in [sender, recipient] {
        sqlx::query("INSERT INTO accounts (account_id, username) VALUES ($1,$2)")
            .bind(id)
            .bind(id.to_string())
            .execute(&pool)
            .await
            .unwrap();
    }
    for (id, account) in [(a, sender), (b, recipient)] {
        sqlx::query("INSERT INTO devices (device_id,account_id,identity_key,auth_token_hash) VALUES ($1,$2,$3,$4)").bind(id).bind(account).bind(vec![1_u8]).bind(token_hash(&id.to_string())).execute(&pool).await.unwrap();
    }
    presence::set_grant(&pool, a, &a.to_string(), recipient, 0, true)
        .await
        .unwrap();
    assert!(matches!(
        presence::publish(&pool, a, &a.to_string(), recipient, 1, &vec![0; 8193]).await,
        Err(Error::Invalid)
    ));
    presence::publish(&pool, a, &a.to_string(), recipient, 1, b"opaque")
        .await
        .unwrap();
    sqlx::query("UPDATE presence_leases SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    for _ in 0..120 {
        assert!(
            presence::poll(&pool, b, &b.to_string(), sender)
                .await
                .unwrap()
                .is_empty()
        );
    }
    assert!(matches!(
        presence::poll(&pool, b, &b.to_string(), sender).await,
        Err(Error::Limited)
    ));
}

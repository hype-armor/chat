//! Security regressions for the internal experiment. These tests do not enable presence.
//! Run ignored tests against an isolated PostgreSQL instance with:
//! `cargo test -p chat-server presence_replacement::tests::security_regressions -- --ignored`
//! Each ignored test currently fails at the security assertion described below.

use super::*;

async fn replacement_device(pool: &PgPool, old_device: Uuid) -> (Uuid, String) {
    let account: Uuid = sqlx::query_scalar("SELECT account_id FROM devices WHERE device_id=$1")
        .bind(old_device)
        .fetch_one(pool)
        .await
        .unwrap();
    let device = Uuid::new_v4();
    let token = device.to_string();
    sqlx::query("INSERT INTO devices (device_id,account_id,identity_key,auth_token_hash) VALUES ($1,$2,$3,$4)")
        .bind(device).bind(account).bind(vec![2_u8]).bind(Sha256::digest(token.as_bytes()).to_vec())
        .execute(pool).await.unwrap();
    (device, token)
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "security regression: a new device can allocate the retired A group"]
async fn recovery_device_must_not_reactivate_retired_group(pool: PgPool) {
    let (device, token, recipient) = setup(&pool).await;
    let old = scope(device, &token, recipient);
    replace(&pool, &old, 0, 1, b"A", Uuid::new_v4())
        .await
        .unwrap();
    replace(&pool, &old, 1, 2, b"B", Uuid::new_v4())
        .await
        .unwrap();
    let (new_device, new_token) = replacement_device(&pool, device).await;
    sqlx::query("DELETE FROM devices WHERE device_id=$1")
        .bind(device)
        .execute(&pool)
        .await
        .unwrap();
    let recovered = scope(new_device, &new_token, recipient);
    assert!(matches!(
        replace(&pool, &recovered, 0, 1, b"A", Uuid::new_v4()).await,
        Err(Error::Conflict)
    ));
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "security regression: regrant validates and retries the pre-revocation group"]
async fn regrant_requires_fresh_group_and_retains_tombstones(pool: PgPool) {
    let (device, token, recipient) = setup(&pool).await;
    let mut s = scope(device, &token, recipient);
    let op_a = Uuid::new_v4();
    let op_b = Uuid::new_v4();
    replace(&pool, &s, 0, 1, b"A", op_a).await.unwrap();
    replace(&pool, &s, 1, 2, b"B", op_b).await.unwrap();
    crate::presence::set_grant(&pool, device, &token, recipient, 1, false)
        .await
        .unwrap();
    crate::presence::set_grant(&pool, device, &token, recipient, 2, true)
        .await
        .unwrap();
    s.grant_generation = 3;
    assert!(
        !validate(&pool, &s, 2, b"B").await.unwrap(),
        "revoked audience retains B keys"
    );
    assert!(matches!(
        replace(&pool, &s, 1, 2, b"B", op_b).await,
        Err(Error::Conflict)
    ));
    replace(&pool, &s, 2, 3, b"C", Uuid::new_v4())
        .await
        .unwrap();
    assert!(validate(&pool, &s, 3, b"C").await.unwrap());
    for group in [b"A", b"B"] {
        assert!(matches!(
            replace(&pool, &s, 3, 4, group, Uuid::new_v4()).await,
            Err(Error::Conflict)
        ));
    }
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "security regression: an old operation succeeds after regrant"]
async fn regrant_must_reject_old_operation_retry(pool: PgPool) {
    let (device, token, recipient) = setup(&pool).await;
    let mut s = scope(device, &token, recipient);
    let operation = Uuid::new_v4();
    replace(&pool, &s, 0, 1, b"A", operation).await.unwrap();
    crate::presence::set_grant(&pool, device, &token, recipient, 1, false)
        .await
        .unwrap();
    crate::presence::set_grant(&pool, device, &token, recipient, 2, true)
        .await
        .unwrap();
    s.grant_generation = 3;
    assert!(matches!(
        replace(&pool, &s, 0, 1, b"A", operation).await,
        Err(Error::Conflict)
    ));
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "security regression: device churn resets the scope allocation limit"]
async fn device_churn_must_not_reset_allocation_limit(pool: PgPool) {
    let (device, token, recipient) = setup(&pool).await;
    sqlx::query("INSERT INTO presence_replacement_scopes (sender_device,recipient,direct_id) SELECT $1,$2,convert_to('scope-'||n,'UTF8') FROM generate_series(1,1024) n")
        .bind(device).bind(recipient).execute(&pool).await.unwrap();
    let old = scope(device, &token, recipient);
    assert!(matches!(
        replace(&pool, &old, 0, 1, b"A", Uuid::new_v4()).await,
        Err(Error::Limited)
    ));
    let (new_device, new_token) = replacement_device(&pool, device).await;
    sqlx::query("DELETE FROM devices WHERE device_id=$1")
        .bind(device)
        .execute(&pool)
        .await
        .unwrap();
    let new = scope(new_device, &new_token, recipient);
    assert!(matches!(
        replace(&pool, &new, 0, 1, b"A", Uuid::new_v4()).await,
        Err(Error::Limited)
    ));
}

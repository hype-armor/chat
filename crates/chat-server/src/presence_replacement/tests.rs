use super::*;
use sha2::{Digest, Sha256};

#[path = "security_regressions.rs"]
mod security_regressions;

async fn setup(db: &PgPool) -> (Uuid, String, Uuid) {
    let sender = Uuid::new_v4();
    let recipient = Uuid::new_v4();
    for id in [sender, recipient] {
        sqlx::query("INSERT INTO accounts (account_id,username) VALUES ($1,$2)")
            .bind(id)
            .bind(id.to_string())
            .execute(db)
            .await
            .unwrap();
    }
    let device = Uuid::new_v4();
    let token = device.to_string();
    sqlx::query("INSERT INTO devices (device_id,account_id,identity_key,auth_token_hash) VALUES ($1,$2,$3,$4)")
        .bind(device).bind(sender).bind(vec![1_u8]).bind(Sha256::digest(token.as_bytes()).to_vec()).execute(db).await.unwrap();
    crate::presence::set_grant(db, device, &token, recipient, 0, true)
        .await
        .unwrap();
    (device, token, recipient)
}
fn scope(device: Uuid, token: &str, recipient: Uuid) -> Scope<'_> {
    Scope {
        device,
        token,
        recipient,
        direct: b"direct",
        grant_generation: 1,
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn replay_idempotency_and_revocation(pool: PgPool) {
    let (device, token, recipient) = setup(&pool).await;
    let mut s = scope(device, &token, recipient);
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    replace(&pool, &s, 0, 1, b"A", a).await.unwrap();
    replace(&pool, &s, 0, 1, b"A", a).await.unwrap();
    assert!(matches!(
        replace(&pool, &s, 0, 1, b"B", a).await,
        Err(Error::Conflict)
    ));
    replace(&pool, &s, 1, 2, b"B", b).await.unwrap();
    assert!(matches!(
        replace(&pool, &s, 0, 1, b"A", a).await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        replace(&pool, &s, 2, 3, b"A", Uuid::new_v4()).await,
        Err(Error::Conflict)
    ));
    assert!(!validate(&pool, &s, 1, b"A").await.unwrap());
    assert!(validate(&pool, &s, 2, b"B").await.unwrap());
    crate::presence::set_grant(&pool, device, &token, recipient, 1, false)
        .await
        .unwrap();
    assert!(matches!(
        validate(&pool, &s, 2, b"B").await,
        Err(Error::Unauthorized)
    ));
    crate::presence::set_grant(&pool, device, &token, recipient, 2, true)
        .await
        .unwrap();
    s.grant_generation = 3;
    assert!(matches!(
        replace(&pool, &s, 2, 3, b"A", Uuid::new_v4()).await,
        Err(Error::Conflict)
    ));
    assert!(validate(&pool, &s, 2, b"B").await.unwrap());
}

#[sqlx::test(migrations = "./migrations")]
async fn concurrent_proposals_and_revocation(pool: PgPool) {
    let (device, token, recipient) = setup(&pool).await;
    let s = scope(device, &token, recipient);
    let (a, b) = tokio::join!(
        replace(&pool, &s, 0, 1, b"A", Uuid::new_v4()),
        replace(&pool, &s, 0, 1, b"B", Uuid::new_v4())
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let (proposal, revoke) = tokio::join!(
        replace(&pool, &s, 1, 2, b"C", Uuid::new_v4()),
        crate::presence::set_grant(&pool, device, &token, recipient, 1, false)
    );
    revoke.unwrap();
    assert!(proposal.is_ok() || matches!(proposal, Err(Error::Unauthorized)));
    assert!(matches!(
        validate(&pool, &s, 2, b"C").await,
        Err(Error::Unauthorized)
    ));
}

#[sqlx::test(migrations = "./migrations")]
async fn bounds_and_scope_isolation(pool: PgPool) {
    let (device, token, recipient) = setup(&pool).await;
    let mut s = scope(device, &token, recipient);
    assert!(matches!(
        replace(&pool, &s, 0, 1, b"", Uuid::new_v4()).await,
        Err(Error::Invalid)
    ));
    assert!(matches!(
        replace(&pool, &s, 0, MAX_GENERATION + 1, b"A", Uuid::new_v4()).await,
        Err(Error::Invalid)
    ));
    replace(&pool, &s, 0, 1, b"A", Uuid::new_v4())
        .await
        .unwrap();
    s.direct = b"other";
    replace(&pool, &s, 0, 1, b"A", Uuid::new_v4())
        .await
        .unwrap();
    // Fill history directly to exercise the fail-closed boundary without 1024 transactions.
    sqlx::query("INSERT INTO presence_replacement_history (sender_device,recipient,direct_id,operation,expected,generation,group_id) SELECT $1,$2,$3,md5(n::text)::uuid,0,1,convert_to('fill-'||n,'UTF8') FROM generate_series(1,1023) n")
        .bind(device).bind(recipient).bind(s.direct).execute(&pool).await.unwrap();
    assert!(matches!(
        replace(&pool, &s, 1, 2, b"new", Uuid::new_v4()).await,
        Err(Error::Limited)
    ));
    assert!(validate(&pool, &s, 1, b"A").await.unwrap());
    sqlx::query("INSERT INTO presence_replacement_scopes (sender_device,recipient,direct_id) SELECT $1,$2,convert_to('scope-'||n,'UTF8') FROM generate_series(1,1022) n")
        .bind(device).bind(recipient).execute(&pool).await.unwrap();
    s.direct = b"one-too-many";
    assert!(matches!(
        replace(&pool, &s, 0, 1, b"A", Uuid::new_v4()).await,
        Err(Error::Limited)
    ));
    sqlx::query("DELETE FROM devices WHERE device_id=$1")
        .bind(device)
        .execute(&pool)
        .await
        .unwrap();
    let retained: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM presence_replacement_history WHERE sender_device=$1",
    )
    .bind(device)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(retained, 1025);
    assert!(matches!(
        validate(&pool, &s, 1, b"A").await,
        Err(Error::Unauthorized)
    ));
}

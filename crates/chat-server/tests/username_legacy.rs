//! Mixed-version account writes use the same permanent username reservations.
mod support;

use serde_json::json;
use sqlx::{Acquire, PgPool};
use support::TestServer;
use uuid::Uuid;

#[sqlx::test]
async fn legacy_registration_rename_and_deletion(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let old = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (account_id, username) VALUES ($1, 'legacy.01')")
        .bind(old)
        .execute(&pool)
        .await
        .unwrap();
    let (device, token) = server.register("other.01").await;
    // Attach an authenticated device to the account created by old SQL.
    sqlx::query("UPDATE devices SET account_id = $1 WHERE device_id = $2")
        .bind(old)
        .bind(device)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(&token),
                json!({"username":"legacy.03", "request_id":Uuid::new_v4()})
            )
            .await
            .0,
        200
    );
    let retired: (bool,) =
        sqlx::query_as("SELECT retired FROM username_reservations WHERE username = 'legacy.01'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(retired.0);
    sqlx::query("UPDATE accounts SET username = 'legacy.02' WHERE account_id = $1")
        .bind(old)
        .execute(&pool)
        .await
        .unwrap();
    let (_, token) = server.register("other.02").await;
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(&token),
                json!({"username":"legacy.01", "request_id":Uuid::new_v4()})
            )
            .await
            .0,
        409
    );
    sqlx::query("DELETE FROM accounts WHERE account_id = $1")
        .bind(old)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(&token),
                json!({"username":"legacy.02", "request_id":Uuid::new_v4()})
            )
            .await
            .0,
        200
    );
    let rejected =
        sqlx::query("INSERT INTO accounts (account_id, username) VALUES ($1, 'legacy.01')")
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .unwrap_err();
    assert_eq!(
        rejected.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
}

#[sqlx::test]
async fn legacy_writes_rollback_and_race_with_reservation(pool: PgPool) {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO accounts (account_id, username) VALUES ($1, 'race.01')")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let p = pool.clone();
    let contender = tokio::spawn(async move {
        sqlx::query("INSERT INTO username_reservations (username, account_id) VALUES ('race.01', $1) ON CONFLICT DO NOTHING RETURNING username")
            .bind(Uuid::new_v4()).fetch_optional(&p).await.unwrap()
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!contender.is_finished());
    tx.rollback().await.unwrap();
    assert!(contender.await.unwrap().is_some());
    let count: (i64,) = sqlx::query_as("SELECT count(*) FROM accounts WHERE account_id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count.0, 0);

    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO accounts (account_id, username) VALUES ($1, 'rollback.01')")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE accounts SET username = 'rollback.02' WHERE account_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    let count: (i64,) = sqlx::query_as("SELECT count(*) FROM username_reservations WHERE username IN ('rollback.01', 'rollback.02')")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(count.0, 0);
}

// The old binary uses ON CONFLICT against accounts, not against reservations.
#[sqlx::test]
async fn old_registration_collision_raises_before_accounts_conflict_handling(pool: PgPool) {
    let owner = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (account_id, username) VALUES ($1, 'owned.01')")
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
    let error = sqlx::query("INSERT INTO accounts (account_id, username) VALUES ($1, 'owned.01') ON CONFLICT (username) DO NOTHING RETURNING account_id")
        .bind(Uuid::new_v4()).fetch_optional(&pool).await.unwrap_err();
    let db = error.as_database_error().unwrap();
    assert_eq!(db.code().as_deref(), Some("23505"));
    assert_eq!(db.constraint(), Some("username_reservations_pkey"));
}

// A retired name has no account row for ON CONFLICT to find. The old binary
// receives this error rather than its normal collision result; no ghost is made.
#[sqlx::test]
async fn old_registration_of_retired_name_fails_closed(pool: PgPool) {
    let owner = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (account_id, username) VALUES ($1, 'retired.01')")
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE accounts SET username = 'current.01' WHERE account_id = $1")
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
    let error = sqlx::query("INSERT INTO accounts (account_id, username) VALUES ($1, 'retired.01') ON CONFLICT (username) DO NOTHING RETURNING account_id")
        .bind(Uuid::new_v4()).fetch_optional(&pool).await.unwrap_err();
    let db = error.as_database_error().unwrap();
    assert_eq!(db.code().as_deref(), Some("23505"));
    assert_eq!(db.constraint(), Some("username_reservations_pkey"));
    let (accounts,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM accounts WHERE username = 'retired.01'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(accounts, 0);
    let reservation: (Uuid, bool) = sqlx::query_as(
        "SELECT account_id, retired FROM username_reservations WHERE username = 'retired.01'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reservation, (owner, true));
}

// Run the actual migration over populated pre-0020 tables in a private schema.
#[sqlx::test]
async fn migration_reconciles_populated_mixed_version_state(pool: PgPool) {
    let mut conn = pool.acquire().await.unwrap();
    sqlx::raw_sql("CREATE SCHEMA migration_review; SET search_path TO migration_review; CREATE TABLE accounts (account_id UUID PRIMARY KEY, username TEXT NOT NULL UNIQUE); CREATE TABLE username_reservations (username TEXT PRIMARY KEY, account_id UUID NOT NULL, retired BOOLEAN NOT NULL DEFAULT FALSE);")
        .execute(&mut *conn).await.unwrap();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts VALUES ($1, 'live.01'), ($2, 'oldwrite.01')")
        .bind(a)
        .bind(b)
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO username_reservations VALUES ('live.01', $1, false), ('deleted.01', $2, false), ('retired.01', $2, true), ('oldwrite.01', $1, false)")
        .bind(a).bind(b).execute(&mut *conn).await.unwrap();
    let mut tx = conn.begin().await.unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/0020_username_legacy_coordination.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let rows: Vec<(String, Uuid, bool)> = sqlx::query_as(
        "SELECT username, account_id, retired FROM username_reservations ORDER BY username",
    )
    .fetch_all(&mut *conn)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("live.01".into(), a, false),
            ("oldwrite.01".into(), b, false),
            ("retired.01".into(), b, true)
        ]
    );
}

// A reservation-first writer and the real migration can form a lock cycle.
// Use lock_timeout instead of waiting for PostgreSQL's deadlock detector.
#[sqlx::test]
async fn migration_requires_draining_reservation_first_writers(pool: PgPool) {
    let mut writer = pool.acquire().await.unwrap();
    sqlx::raw_sql("CREATE SCHEMA migration_lock_review; SET search_path TO migration_lock_review; CREATE TABLE accounts (account_id UUID PRIMARY KEY, username TEXT NOT NULL UNIQUE); CREATE TABLE username_reservations (username TEXT PRIMARY KEY, account_id UUID NOT NULL, retired BOOLEAN NOT NULL DEFAULT FALSE);")
        .execute(&mut *writer).await.unwrap();
    let mut tx = writer.begin().await.unwrap();
    let (pid,): (i32,) = sqlx::query_as("SELECT pg_backend_pid()")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO username_reservations VALUES ('locking.01', $1, false)")
        .bind(Uuid::new_v4())
        .execute(&mut *tx)
        .await
        .unwrap();
    let p = pool.clone();
    let migration = async move {
        let mut conn = p.acquire().await.unwrap();
        sqlx::query("SET search_path TO migration_lock_review")
            .execute(&mut *conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        sqlx::raw_sql(include_str!(
            "../migrations/0020_username_legacy_coordination.sql"
        ))
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
    };
    let writer_check = async {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let (blocked,): (bool,) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))")
                .bind(pid).fetch_one(&pool).await.unwrap();
            if blocked { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("migration did not wait for reservation writer");
        sqlx::query("SET LOCAL lock_timeout = '200ms'")
            .execute(&mut *tx)
            .await
            .unwrap();
        let error = sqlx::query("INSERT INTO accounts VALUES ($1, 'locking.01')")
            .bind(Uuid::new_v4())
            .execute(&mut *tx)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("55P03")
        );
        tx.rollback().await.unwrap();
    };
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        tokio::join!(migration, writer_check);
    })
    .await
    .unwrap();
}

#[sqlx::test]
async fn migration_conflict_rolls_back_reconciliation(pool: PgPool) {
    let mut conn = pool.acquire().await.unwrap();
    sqlx::raw_sql("CREATE SCHEMA migration_failure_review; SET search_path TO migration_failure_review; CREATE TABLE accounts (account_id UUID PRIMARY KEY, username TEXT NOT NULL UNIQUE); CREATE TABLE username_reservations (username TEXT PRIMARY KEY, account_id UUID NOT NULL, retired BOOLEAN NOT NULL DEFAULT FALSE);")
        .execute(&mut *conn).await.unwrap();
    let owner = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts VALUES ($1, 'retired.01')")
        .bind(owner)
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO username_reservations VALUES ('retired.01', $1, true), ('stale.01', $1, false)")
        .bind(owner).execute(&mut *conn).await.unwrap();
    let mut tx = conn.begin().await.unwrap();
    let error = sqlx::raw_sql(include_str!(
        "../migrations/0020_username_legacy_coordination.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("account username conflicts with a permanent reservation")
    );
    tx.rollback().await.unwrap();
    let count: (i64,) =
        sqlx::query_as("SELECT count(*) FROM username_reservations WHERE username = 'stale.01'")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
    assert_eq!(count.0, 1);
    let trigger: (i64,) = sqlx::query_as("SELECT count(*) FROM pg_trigger WHERE tgrelid = 'accounts'::regclass AND tgname = 'accounts_username_coordination'")
        .fetch_one(&mut *conn).await.unwrap();
    assert_eq!(trigger.0, 0);
}

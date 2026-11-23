//! Deletion confirmations survive rename but do not authorize another account.
mod support;

use serde_json::json;
use sqlx::PgPool;
use support::TestServer;
use uuid::Uuid;

#[sqlx::test]
async fn authorization_survives_rename_and_is_account_bound(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, alice) = server.register("alice.40").await;
    let (_, bob) = server.register("bob.40").await;
    let secret = "ab".repeat(32);
    let prepare = json!({"username":"alice.40", "authorization":secret});
    assert_eq!(
        server
            .post("/v1/account/delete/prepare", Some(&alice), prepare.clone())
            .await
            .0,
        204
    );
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(&alice),
                json!({"username":"alice.41", "request_id":Uuid::new_v4()})
            )
            .await
            .0,
        200
    );
    // A lost prepare response can be retried after the rename.
    assert_eq!(
        server
            .post("/v1/account/delete/prepare", Some(&alice), prepare)
            .await
            .0,
        204
    );
    assert_eq!(
        server
            .post(
                "/v1/account/delete",
                Some(&bob),
                json!({"authorization":secret})
            )
            .await
            .0,
        409
    );
    assert_eq!(
        server
            .post(
                "/v1/account/delete",
                Some(&alice),
                json!({"authorization":secret})
            )
            .await
            .0,
        204
    );
    assert_eq!(
        server
            .post(
                "/v1/account/delete",
                Some(&alice),
                json!({"authorization":secret})
            )
            .await
            .0,
        401
    );
}

#[sqlx::test]
async fn stale_confirmation_and_expired_authorization_fail(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, alice) = server.register("alice.40").await;
    let secret = "cd".repeat(32);
    assert_eq!(
        server
            .post(
                "/v1/account/delete/prepare",
                Some(&alice),
                json!({"username":"wrong.40", "authorization":secret})
            )
            .await
            .0,
        400
    );
    let body = json!({"username":"alice.40", "authorization":secret});
    assert_eq!(
        server
            .post("/v1/account/delete/prepare", Some(&alice), body.clone())
            .await
            .0,
        204
    );
    sqlx::query(
        "UPDATE account_deletion_authorizations SET expires_at = now() - interval '1 second'",
    )
    .execute(server.state.db.as_ref().unwrap())
    .await
    .unwrap();
    assert_eq!(
        server
            .post("/v1/account/delete/prepare", Some(&alice), body)
            .await
            .0,
        409
    );
    assert_eq!(
        server
            .post(
                "/v1/account/delete",
                Some(&alice),
                json!({"authorization":secret})
            )
            .await
            .0,
        409
    );
}

// Wait until the handler has authenticated and is blocked on our account lock.
async fn wait_for_blocked(pool: &PgPool, blocker: i32) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let (blocked,): (bool,) = sqlx::query_as(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%FOR UPDATE OF a%')",
            )
            .bind(blocker)
            .fetch_one(pool)
            .await
            .unwrap();
            if blocked { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("handler did not wait for account lock");
}

#[sqlx::test]
async fn committed_revocation_wins_against_waiting_deletion(pool: PgPool) {
    let server = std::sync::Arc::new(TestServer::start(pool.clone()).await);
    let (device, token) = server.register("alice.40").await;
    let secret = "ef".repeat(32);
    assert_eq!(
        server
            .post(
                "/v1/account/delete/prepare",
                Some(&token),
                json!({"username":"alice.40", "authorization":secret})
            )
            .await
            .0,
        204
    );
    let mut blocker = pool.begin().await.unwrap();
    let (pid,): (i32,) = sqlx::query_as("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query("SELECT 1 FROM accounts WHERE username = 'alice.40' FOR UPDATE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let task = {
        let server = server.clone();
        tokio::spawn(async move {
            server
                .post(
                    "/v1/account/delete",
                    Some(&token),
                    json!({"authorization":secret}),
                )
                .await
                .0
        })
    };
    wait_for_blocked(&pool, pid).await;
    sqlx::query("DELETE FROM devices WHERE device_id = $1")
        .bind(device)
        .execute(&pool)
        .await
        .unwrap();
    blocker.commit().await.unwrap();
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap(),
        401
    );
    let (exists,): (bool,) =
        sqlx::query_as("SELECT EXISTS(SELECT 1 FROM accounts WHERE username = 'alice.40')")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(exists);
}

#[sqlx::test]
async fn authorization_expires_while_waiting_for_account_lock(pool: PgPool) {
    let server = std::sync::Arc::new(TestServer::start(pool.clone()).await);
    let (_, token) = server.register("alice.40").await;
    let secret = "12".repeat(32);
    let body = json!({"username":"alice.40", "authorization":secret});
    assert_eq!(
        server
            .post("/v1/account/delete/prepare", Some(&token), body.clone())
            .await
            .0,
        204
    );
    for path in ["/v1/account/delete/prepare", "/v1/account/delete"] {
        sqlx::query("UPDATE account_deletion_authorizations SET expires_at = clock_timestamp() + interval '2 seconds'").execute(&pool).await.unwrap();
        let mut blocker = pool.begin().await.unwrap();
        let (pid,): (i32,) = sqlx::query_as("SELECT pg_backend_pid()")
            .fetch_one(&mut *blocker)
            .await
            .unwrap();
        sqlx::query("SELECT 1 FROM accounts WHERE username = 'alice.40' FOR UPDATE")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let task = {
            let server = server.clone();
            let token = token.clone();
            let body = body.clone();
            tokio::spawn(async move { server.post(path, Some(&token), body).await.0 })
        };
        wait_for_blocked(&pool, pid).await;
        sqlx::query("SELECT pg_sleep(2.1)")
            .execute(&mut *blocker)
            .await
            .unwrap();
        blocker.commit().await.unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(10), task)
                .await
                .unwrap()
                .unwrap(),
            409
        );
    }
}

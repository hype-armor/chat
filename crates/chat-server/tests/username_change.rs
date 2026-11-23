//! Username changes preserve account identity and reserve retired names.
mod support;

use serde_json::json;
use sqlx::PgPool;
use support::TestServer;
use uuid::Uuid;

#[sqlx::test]
async fn rename_retries_collisions_and_deletion(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, alice) = server.register("alice.40").await;
    let (_, bob) = server.register("bob.40").await;
    let before = server.get("/v1/account", Some(&alice)).await.1;
    let id = Uuid::new_v4();
    let body = json!({"username":" Alice.41 ", "request_id":id});
    let (status, changed) = server
        .post("/v1/account/username", Some(&alice), body.clone())
        .await;
    assert_eq!(status, 200);
    assert_eq!(changed["account_id"], before["account_id"]);
    assert_eq!(changed["username"], "alice.41");
    assert_eq!(
        server
            .post("/v1/account/username", Some(&alice), body)
            .await
            .0,
        200
    );
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(&alice),
                json!({"username":"alice.42", "request_id":id})
            )
            .await
            .0,
        409
    );
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(&bob),
                json!({"username":"alice.40", "request_id":Uuid::new_v4()})
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
                json!({"username":"alice.40"})
            )
            .await
            .0,
        400
    );
    assert_eq!(
        server
            .post(
                "/v1/account/delete",
                Some(&alice),
                json!({"username":"alice.41"})
            )
            .await
            .0,
        204
    );
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(&bob),
                json!({"username":"alice.40", "request_id":Uuid::new_v4()})
            )
            .await
            .0,
        409
    );
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(&bob),
                json!({"username":"alice.41", "request_id":Uuid::new_v4()})
            )
            .await
            .0,
        200
    );
}

#[sqlx::test]
async fn repeated_name_collisions_are_rate_limited(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, alice) = server.register("alice.60").await;
    let (_, bob) = server.register("bobby.60").await;
    for _ in 0..60 {
        assert_eq!(
            server
                .post(
                    "/v1/account/username",
                    Some(&alice),
                    json!({"username":"bobby.60", "request_id":Uuid::new_v4()})
                )
                .await
                .0,
            409
        );
    }
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(&alice),
                json!({"username":"bobby.60", "request_id":Uuid::new_v4()})
            )
            .await
            .0,
        429
    );
    // A different device's budget remains independent.
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(&bob),
                json!({"username":"alice.60", "request_id":Uuid::new_v4()})
            )
            .await
            .0,
        409
    );
}

#[sqlx::test]
async fn concurrent_rename_has_one_winner_and_budget_limits_new_requests(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, a) = server.register("alice.50").await;
    let (_, b) = server.register("bobby.50").await;
    let one = json!({"username":"target.50", "request_id":Uuid::new_v4()});
    let two = json!({"username":"target.50", "request_id":Uuid::new_v4()});
    let (x, y) = tokio::join!(
        server.post("/v1/account/username", Some(&a), one),
        server.post("/v1/account/username", Some(&b), two)
    );
    let mut statuses = [x.0, y.0];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let winner = if x.0 == 200 { &a } else { &b };
    for i in 0..4 {
        let name = format!("winner.{:02}", i);
        assert_eq!(
            server
                .post(
                    "/v1/account/username",
                    Some(winner),
                    json!({"username":name, "request_id":Uuid::new_v4()})
                )
                .await
                .0,
            200
        );
    }
    assert_eq!(
        server
            .post(
                "/v1/account/username",
                Some(winner),
                json!({"username":"winner.99", "request_id":Uuid::new_v4()})
            )
            .await
            .0,
        429
    );
}

#[sqlx::test]
async fn revoked_device_cannot_rename_after_waiting_for_account_lock(pool: PgPool) {
    let server = std::sync::Arc::new(TestServer::start(pool.clone()).await);
    let (device, token) = server.register("alice.40").await;
    let request_id = Uuid::new_v4();
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
                    "/v1/account/username",
                    Some(&token),
                    json!({"username":"alice.41", "request_id":request_id}),
                )
                .await
                .0
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let (blocked,): (bool,) = sqlx::query_as(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%FOR UPDATE OF a%')",
            )
            .bind(pid)
            .fetch_one(&pool)
            .await
            .unwrap();
            if blocked {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("rename did not wait for account lock");
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
    let (username,): (String,) = sqlx::query_as("SELECT username FROM accounts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(username, "alice.40");
    let reservations: Vec<(String, bool)> =
        sqlx::query_as("SELECT username, retired FROM username_reservations ORDER BY username")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(reservations, vec![("alice.40".to_string(), false)]);
    let (changes,): (i64,) = sqlx::query_as("SELECT count(*) FROM username_changes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(changes, 0);
}

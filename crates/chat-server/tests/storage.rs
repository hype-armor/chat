//! Durable object-store accounting. Each test uses an isolated database.
mod support;

use std::sync::Arc;

use axum::{body::Body, http::Request};
use base64::{Engine, engine::general_purpose::STANDARD};
use chat_server::{blobs, router, storage};
use object_store::{ObjectStore, ObjectStoreExt};
use serde_json::json;
use sqlx::PgPool;
use support::TestServer;
use tower::ServiceExt;
use uuid::Uuid;

async fn account(pool: &PgPool, device: Uuid) -> Uuid {
    let (id,): (Uuid,) = sqlx::query_as("SELECT account_id FROM devices WHERE device_id = $1")
        .bind(device)
        .fetch_one(pool)
        .await
        .unwrap();
    id
}

#[sqlx::test]
async fn concurrent_reservations_obey_server_and_account_limits(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (a, _) = server.register("ann.01").await;
    let (b, _) = server.register("ben.01").await;
    let a = account(&pool, a).await;
    let b = account(&pool, b).await;
    sqlx::query("UPDATE storage_policy SET server_bytes = 10, account_bytes = NULL WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let first = vec![("first".to_owned(), 7)];
    let second = vec![("second".to_owned(), 7)];
    let (x, y) = tokio::join!(
        storage::reserve(&pool, a, &first),
        storage::reserve(&pool, b, &second)
    );
    assert_ne!(
        x.is_ok(),
        y.is_ok(),
        "only one server-wide reservation fits"
    );
    sqlx::query("DELETE FROM storage_objects")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE storage_policy SET server_bytes = NULL, account_bytes = 10 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let (x, y) = tokio::join!(
        storage::reserve(&pool, a, &first),
        storage::reserve(&pool, a, &second)
    );
    assert_ne!(x.is_ok(), y.is_ok(), "only one account reservation fits");
    assert_eq!(
        storage::account_usage(&pool, a)
            .await
            .unwrap()
            .reserved_bytes,
        7
    );
}

#[sqlx::test]
async fn overrides_support_unlimited_zero_and_inheritance(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (device, _) = server.register("ann.01").await;
    let a = account(&pool, device).await;
    sqlx::query("UPDATE storage_policy SET account_bytes = 5 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        storage::reserve(&pool, a, &[("large".into(), 6)])
            .await
            .is_err()
    );
    sqlx::query("INSERT INTO account_storage_policy (account_id, limit_bytes) VALUES ($1, NULL)")
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    storage::reserve(&pool, a, &[("large".into(), 6)])
        .await
        .unwrap();
    let usage = storage::account_usage(&pool, a).await.unwrap();
    assert_eq!(usage.limit_bytes, None);
    assert!(usage.overridden);
    sqlx::query("UPDATE account_storage_policy SET limit_bytes = 0 WHERE account_id = $1")
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        storage::reserve(&pool, a, &[("blocked".into(), 1)])
            .await
            .is_err()
    );
    sqlx::query("DELETE FROM account_storage_policy WHERE account_id = $1")
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    let usage = storage::account_usage(&pool, a).await.unwrap();
    assert_eq!(usage.limit_bytes, Some(5));
    assert!(!usage.overridden);
    assert_eq!(
        usage.reserved_bytes, 6,
        "lowering the cap does not delete data"
    );
    sqlx::query("UPDATE storage_policy SET account_bytes = NULL WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    storage::reserve(&pool, a, &[("unlimited-default".into(), 100)])
        .await
        .unwrap();
    sqlx::query("UPDATE storage_policy SET server_bytes = 0 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        storage::reserve(&pool, a, &[("server-blocked".into(), 1)])
            .await
            .is_err()
    );
}

#[sqlx::test]
async fn usage_is_private_and_includes_uncommitted_bytes(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (_, token) = server.register("ann.01").await;
    let (_, other) = server.register("ben.01").await;
    assert_eq!(
        server.raw("PUT", "/v1/blobs", &token, vec![1; 3]).await.0,
        200
    );
    assert_eq!(
        server
            .post("/v1/blobs/uploads", Some(&token), json!({"size": 4}))
            .await
            .0,
        200
    );
    let (status, usage) = server.get("/v1/storage", Some(&token)).await;
    assert_eq!(status, 200);
    assert_eq!(usage["used_bytes"], 3);
    assert_eq!(usage["reserved_bytes"], 4);
    assert_eq!(usage["limit_bytes"], 2_147_483_648_i64);
    assert!(usage.get("server_bytes").is_none());
    assert_eq!(
        server.get("/v1/storage", Some(&other)).await.1["used_bytes"],
        0
    );
    assert_eq!(server.get("/v1/storage", None).await.0, 401);
    // A definite multipart abort and confirmed deletion release the charge.
    let request = Request::put("/v1/blobs")
        .header("authorization", format!("Bearer {token}"))
        .header("content-length", 5)
        .body(Body::from(vec![1; 2]))
        .unwrap();
    let response = router(server.state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), 400);
    let (_, usage) = server.get("/v1/storage", Some(&token)).await;
    assert_eq!(usage["used_bytes"], 3);
    assert_eq!(usage["reserved_bytes"], 4);
}

#[sqlx::test]
async fn resumable_completion_transfers_charge_and_fenced_expiry_releases_it(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (_, token) = server.register("ann.01").await;
    sqlx::query("UPDATE storage_policy SET account_bytes = 4 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let (_, session) = server
        .post("/v1/blobs/uploads", Some(&token), json!({"size": 4}))
        .await;
    let id = session["upload_id"].as_str().unwrap();
    assert_eq!(
        server
            .raw(
                "PUT",
                &format!("/v1/blobs/uploads/{id}/0"),
                &token,
                vec![3; 4]
            )
            .await
            .0,
        204
    );
    assert_eq!(
        server.get("/v1/storage", Some(&token)).await.1["reserved_bytes"],
        4
    );
    assert_eq!(
        server
            .post(
                &format!("/v1/blobs/uploads/{id}/complete"),
                Some(&token),
                json!({})
            )
            .await
            .0,
        200
    );
    let (_, usage) = server.get("/v1/storage", Some(&token)).await;
    assert_eq!(usage["used_bytes"], 4);
    assert_eq!(usage["reserved_bytes"], 0);
    sqlx::query("UPDATE blobs SET expires_at = now() - interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    blobs::expire(&pool, server.state.blobs.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(
        server.get("/v1/storage", Some(&token)).await.1["used_bytes"],
        0
    );
    let (_, session) = server
        .post("/v1/blobs/uploads", Some(&token), json!({"size": 4}))
        .await;
    let id = session["upload_id"].as_str().unwrap();
    sqlx::query("UPDATE blob_uploads SET expires_at = now() - interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE storage_objects SET state = 'writing'")
        .execute(&pool)
        .await
        .unwrap();
    blobs::expire(&pool, server.state.blobs.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(
        server.get("/v1/storage", Some(&token)).await.1["reserved_bytes"],
        4
    );
    // A stopped writer needs explicit operator repair, not automatic expiry.
    sqlx::query("UPDATE storage_objects SET state = 'reserved' WHERE object_key = $1")
        .bind(format!("blobs/{id}/0"))
        .execute(&pool)
        .await
        .unwrap();
    blobs::expire(&pool, server.state.blobs.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(
        server.get("/v1/storage", Some(&token)).await.1["used_bytes"],
        0
    );
}

#[sqlx::test]
async fn backup_replacement_needs_peak_space_and_releases_old_object(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (_, token) = server.register("ann.01").await;
    assert_eq!(
        server
            .put_json(
                "/v1/backup/key",
                &token,
                json!({"auth_hash": STANDARD.encode([1; 32])})
            )
            .await
            .0,
        204
    );
    sqlx::query("UPDATE storage_policy SET account_bytes = 10 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, vec![1; 6]).await.0,
        204
    );
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, vec![2; 6]).await.0,
        429
    );
    assert_eq!(
        server.raw("GET", "/v1/backup", &token, vec![]).await.1,
        vec![1; 6]
    );
    sqlx::query("UPDATE storage_policy SET account_bytes = 12 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, vec![2; 6]).await.0,
        204
    );
    let (_, usage) = server.get("/v1/storage", Some(&token)).await;
    assert_eq!(usage["used_bytes"], 6);
    assert_eq!(usage["reserved_bytes"], 0);
    assert_eq!(
        server
            .post("/v1/backup/delete", Some(&token), json!({}))
            .await
            .0,
        204
    );
    assert_eq!(
        server.get("/v1/storage", Some(&token)).await.1["used_bytes"],
        0
    );
}

#[sqlx::test]
async fn deleted_accounts_keep_global_charge_and_failed_delete_never_releases_it(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (device, _) = server.register("ann.01").await;
    let a = account(&pool, device).await;
    storage::reserve(&pool, a, &[("cannot-delete".into(), 7)])
        .await
        .unwrap();
    let dir = std::env::temp_dir().join(format!("chat-storage-{}", Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("cannot-delete")).unwrap();
    let store: Arc<dyn ObjectStore> =
        Arc::new(object_store::local::LocalFileSystem::new_with_prefix(&dir).unwrap());
    assert!(
        storage::forget(&store, &pool, "cannot-delete")
            .await
            .is_err()
    );
    assert_eq!(
        storage::account_usage(&pool, a).await.unwrap().used_bytes,
        0
    );
    assert_eq!(
        storage::account_usage(&pool, a)
            .await
            .unwrap()
            .reserved_bytes,
        7
    );
    sqlx::query("DELETE FROM accounts WHERE account_id = $1")
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    let (owner, bytes): (Option<Uuid>, i64) =
        sqlx::query_as("SELECT account_id, size_bytes FROM storage_objects")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, None);
    assert_eq!(bytes, 7);
    std::fs::remove_dir(dir.join("cannot-delete")).unwrap();
    storage::forget(&store, &pool, "cannot-delete")
        .await
        .unwrap();
    std::fs::remove_dir(dir).unwrap();
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM storage_objects")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "NotFound confirms deletion and releases the charge"
    );
}

#[sqlx::test]
async fn migration_backfills_parts_pending_uploads_backups_and_unknown_owners(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (device, _) = server.register("ann.01").await;
    let (other, _) = server.register("ben.01").await;
    let a = account(&pool, device).await;
    let b = account(&pool, other).await;
    sqlx::query("INSERT INTO blobs (blob_id, size_bytes, parts, expires_at, account_id) VALUES ($1, 8388611, 2, now() - interval '1 day', $2)")
        .bind(Uuid::new_v4()).bind(a).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO blobs (blob_id, size_bytes, expires_at) VALUES ($1, 9, now())")
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO blob_uploads (upload_id, device_id, size_bytes, parts, received, expires_at) VALUES ($1, $2, 8388613, 2, '{0}', now())")
        .bind(Uuid::new_v4()).bind(device).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO blob_uploads (upload_id, device_id, size_bytes, parts, expires_at) VALUES ($1, $2, 7, 1, now())")
        .bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO backups (account_id, auth_hash, object_key, size_bytes) VALUES ($1, $2, 'backups/existing', 11)")
        .bind(a).bind(vec![1_u8; 32]).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO backups (account_id, auth_hash, blob) VALUES ($1, $2, $3)")
        .bind(b)
        .bind(vec![1_u8; 32])
        .bind(vec![2_u8; 13])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(
        "DROP TABLE storage_objects, account_storage_policy, storage_policy;
                   ALTER TABLE blob_uploads DROP COLUMN retiring",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../migrations/0014_storage_quotas.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let usage = storage::account_usage(&pool, a).await.unwrap();
    assert_eq!(usage.used_bytes, 8_388_611 + 11);
    assert_eq!(usage.reserved_bytes, 8_388_613);
    let (unknown,): (i64,) = sqlx::query_as(
        "SELECT sum(size_bytes)::bigint FROM storage_objects WHERE account_id IS NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unknown, 16);
    let legacy = storage::account_usage(&pool, b).await.unwrap();
    assert_eq!(legacy.used_bytes, 0);
    assert_eq!(legacy.reserved_bytes, 13);
    chat_server::backup::move_to_store(&pool, server.state.blobs.as_ref().unwrap())
        .await
        .unwrap();
    let legacy = storage::account_usage(&pool, b).await.unwrap();
    assert_eq!(legacy.used_bytes, 13);
    assert_eq!(legacy.reserved_bytes, 0);
}

#[sqlx::test]
async fn backup_attempt_and_bandwidth_budgets_precede_reservation(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (device, token) = server.register("ann.01").await;
    let a = account(&pool, device).await;
    server
        .put_json(
            "/v1/backup/key",
            &token,
            json!({"auth_hash": STANDARD.encode([1; 32])}),
        )
        .await;
    chat_server::limits::take(
        &pool,
        &format!("backup-uploads:{a}"),
        287,
        288,
        chat_server::limits::DAY,
    )
    .await
    .unwrap();
    let request = Request::put("/v1/backup")
        .header("authorization", format!("Bearer {token}"))
        .header("content-length", 1)
        .body(Body::empty())
        .unwrap();
    let response = router(server.state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), 400);
    let usage = storage::account_usage(&pool, a).await.unwrap();
    assert_eq!(
        usage.used_bytes + usage.reserved_bytes,
        0,
        "confirmed abort releases its charge"
    );
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, vec![1]).await.0,
        429
    );
    sqlx::query("DELETE FROM rate_limits WHERE key = $1")
        .bind(format!("backup-uploads:{a}"))
        .execute(&pool)
        .await
        .unwrap();
    chat_server::limits::take(
        &pool,
        &format!("backup-mb:{a}"),
        2047,
        2048,
        chat_server::limits::DAY,
    )
    .await
    .unwrap();
    assert_eq!(
        server.raw("PUT", "/v1/backup", &token, vec![1]).await.0,
        429,
        "the failed upload consumed the first MiB of the budget"
    );
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM storage_objects")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test]
async fn abandoned_writers_do_not_starve_later_expired_sessions(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (device, token) = server.register("ann.01").await;
    let a = account(&pool, device).await;
    let ids: Vec<Uuid> = (0..1001).map(|_| Uuid::new_v4()).collect();
    sqlx::query(
        "INSERT INTO blob_uploads (upload_id, device_id, size_bytes, parts, expires_at)
                 SELECT id, $2, 1, 1, now() - interval '2 days' FROM unnest($1::uuid[]) AS id",
    )
    .bind(&ids)
    .bind(device)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO storage_objects (object_key, account_id, size_bytes, state)
                 SELECT 'blobs/' || id || '/0', $2, 1, 'writing' FROM unnest($1::uuid[]) AS id",
    )
    .bind(&ids)
    .bind(a)
    .execute(&pool)
    .await
    .unwrap();
    let (_, session) = server
        .post("/v1/blobs/uploads", Some(&token), json!({"size": 4}))
        .await;
    let id: Uuid = session["upload_id"].as_str().unwrap().parse().unwrap();
    sqlx::query(
        "UPDATE blob_uploads SET expires_at = now() - interval '1 second' WHERE upload_id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    blobs::expire(&pool, server.state.blobs.as_ref().unwrap())
        .await
        .unwrap();
    let (later,): (bool,) =
        sqlx::query_as("SELECT EXISTS(SELECT 1 FROM blob_uploads WHERE upload_id = $1)")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !later,
        "the cleanup batch must pass the first 1000 crashed writers"
    );
    let usage = storage::account_usage(&pool, a).await.unwrap();
    assert_eq!(usage.used_bytes, 0);
    assert_eq!(usage.reserved_bytes, 1001);
}

#[sqlx::test]
async fn retirement_fences_a_part_writer_with_a_pre_expiry_transaction(pool: PgPool) {
    let server = Arc::new(TestServer::start(pool.clone()).await);
    let (_, token) = server.register("ann.01").await;
    let (_, session) = server
        .post("/v1/blobs/uploads", Some(&token), json!({"size": 4}))
        .await;
    let id: Uuid = session["upload_id"].as_str().unwrap().parse().unwrap();
    let mut retire = pool.begin().await.unwrap();
    sqlx::query("SELECT upload_id FROM blob_uploads WHERE upload_id = $1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *retire)
        .await
        .unwrap();
    let writer_server = server.clone();
    let writer_token = token.clone();
    let writer = tokio::spawn(async move {
        writer_server
            .raw(
                "PUT",
                &format!("/v1/blobs/uploads/{id}/0"),
                &writer_token,
                vec![1; 4],
            )
            .await
    });
    // Wait until the handler has started its claim transaction and is blocked
    // on the upload row. Its now() must predate the retirement below.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let (waiting,): (bool,) = sqlx::query_as(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                 WHERE datname = current_database() AND pid <> pg_backend_pid()
                   AND wait_event_type = 'Lock'
                   AND query LIKE '%SELECT upload_id FROM blob_uploads%')",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("part writer must wait on the retirement row lock");
    sqlx::query("UPDATE blob_uploads SET expires_at = clock_timestamp() - interval '1 microsecond', retiring = TRUE WHERE upload_id = $1")
        .bind(id).execute(&mut *retire).await.unwrap();
    retire.commit().await.unwrap();
    let (status, _) = writer.await.unwrap();
    assert_eq!(
        status, 404,
        "retirement must fence a stale transaction timestamp"
    );
    let key = object_store::path::Path::from(format!("blobs/{id}/0"));
    assert!(
        server
            .state
            .blobs
            .as_ref()
            .unwrap()
            .get(&key)
            .await
            .is_err()
    );
    blobs::expire(&pool, server.state.blobs.as_ref().unwrap())
        .await
        .unwrap();
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM storage_objects")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "retiring sessions remain eligible for cleanup retries"
    );
}

//! Encrypted attachments (FR-MED-2/3, ADR-0023).
mod support;

use chat_server::{blobs, limits::Limits};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use support::TestServer;

#[sqlx::test]
async fn attachments_are_stored_streamed_back_and_expire(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let (_, other) = server.register("ben.01").await;

    // Bigger than any JSON body; anyone signed in with the id can fetch it.
    let data: Vec<u8> = (0..20 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    let (status, body) = server.raw("PUT", "/v1/blobs", &token, data.clone()).await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let uploaded: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(uploaded["expires_in_days"], 30);
    let id = uploaded["blob_id"].as_str().unwrap();
    let (status, fetched) = server
        .raw("GET", &format!("/v1/blobs/{id}"), &other, vec![])
        .await;
    assert_eq!(status, 200);
    assert!(fetched == data, "same bytes back");
    let unknown = uuid::Uuid::new_v4();
    assert_eq!(
        server
            .raw("GET", &format!("/v1/blobs/{unknown}"), &other, vec![])
            .await
            .0,
        404
    );
    assert_eq!(
        server.raw("PUT", "/v1/blobs", "bogus", vec![1]).await.0,
        401
    );
    assert_eq!(server.raw("PUT", "/v1/blobs", &token, vec![]).await.0, 400);

    // After 30 days it's gone, from the table and the store.
    let db = server.state.db.clone().unwrap();
    sqlx::query("UPDATE blobs SET expires_at = now() - interval '1 second'")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        server
            .raw("GET", &format!("/v1/blobs/{id}"), &other, vec![])
            .await
            .0,
        404
    );
    let store = server.state.blobs.clone().unwrap();
    blobs::expire(&db, &store).await.unwrap();
    let (rows,): (i64,) = sqlx::query_as("SELECT count(*) FROM blobs")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    use object_store::ObjectStoreExt;
    assert!(
        store
            .get(&object_store::path::Path::from(format!("blobs/{id}")))
            .await
            .is_err()
    );
}

#[sqlx::test]
async fn uploads_are_limited_per_device_per_day(pool: PgPool) {
    let server = TestServer::start_with_limits(
        pool,
        Limits {
            blob_mb_per_day: 3,
            ..Limits::default()
        },
    )
    .await;
    let (_, token) = server.register("ann.01").await;
    assert_eq!(
        server
            .raw("PUT", "/v1/blobs", &token, vec![1; 2 * 1024 * 1024])
            .await
            .0,
        200
    );
    assert_eq!(
        server
            .raw("PUT", "/v1/blobs", &token, vec![1; 2 * 1024 * 1024])
            .await
            .0,
        429
    );
    assert_eq!(
        server
            .raw("PUT", "/v1/blobs", &token, vec![1; 1024])
            .await
            .0,
        200
    );
}

#[sqlx::test]
async fn uploads_resume_by_part_and_downloads_by_range(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let (_, other) = server.register("ben.01").await;
    let part = blobs::UPLOAD_PART_BYTES as usize;
    // Two full parts and a short one.
    let data: Vec<u8> = (0..2 * part + 1000).map(|i| (i % 253) as u8).collect();

    let (status, session) = server
        .post(
            "/v1/blobs/uploads",
            Some(&token),
            serde_json::json!({ "size": data.len() }),
        )
        .await;
    assert_eq!(status, 200, "{session}");
    assert_eq!(session["parts"], 3);
    let id = session["upload_id"].as_str().unwrap().to_owned();
    let part_url = |n: usize| format!("/v1/blobs/uploads/{id}/{n}");

    // Parts out of order, one sent twice; wrong sizes and strangers refused.
    let chunk = |n: usize| data[n * part..((n + 1) * part).min(data.len())].to_vec();
    assert_eq!(
        server.raw("PUT", &part_url(2), &token, chunk(2)).await.0,
        204
    );
    assert_eq!(
        server.raw("PUT", &part_url(0), &token, chunk(0)).await.0,
        204
    );
    assert_eq!(
        server.raw("PUT", &part_url(0), &token, chunk(0)).await.0,
        204
    );
    assert_eq!(
        server.raw("PUT", &part_url(1), &token, vec![1; 10]).await.0,
        400
    );
    assert_eq!(
        server.raw("PUT", &part_url(3), &token, chunk(2)).await.0,
        400
    );
    assert_eq!(
        server.raw("PUT", &part_url(1), &other, chunk(1)).await.0,
        404
    );

    // Interrupted: the client asks what arrived, and completing must wait.
    let (status, progress) = server
        .get(&format!("/v1/blobs/uploads/{id}"), Some(&token))
        .await;
    assert_eq!(status, 200);
    assert_eq!(progress["received"], serde_json::json!([0, 2]));
    let complete = format!("/v1/blobs/uploads/{id}/complete");
    assert_eq!(
        server
            .post(&complete, Some(&token), serde_json::json!({}))
            .await
            .0,
        409
    );
    assert_eq!(
        server.raw("PUT", &part_url(1), &token, chunk(1)).await.0,
        204
    );
    let (status, done) = server
        .post(&complete, Some(&token), serde_json::json!({}))
        .await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["blob_id"].as_str().unwrap(), id);

    // Whole, and by ranges that cross part boundaries.
    let url = format!("/v1/blobs/{id}");
    let (whole, _) = server
        .raw_with_range("GET", &url, &other, vec![], None)
        .await;
    assert_eq!(whole.0, 200);
    assert!(whole.1 == data);
    for (range, from, to) in [
        (
            format!("bytes={}-{}", part - 10, part + 9),
            part - 10,
            part + 10,
        ),
        (format!("bytes={}-", 2 * part - 5), 2 * part - 5, data.len()),
        ("bytes=0-99999999999".to_owned(), 0, data.len()),
        ("bytes=5-5".to_owned(), 5, 6),
    ] {
        let ((status, body), content_range) = server
            .raw_with_range("GET", &url, &other, vec![], Some(&range))
            .await;
        assert_eq!(status, 206, "{range}");
        assert!(body == data[from..to], "{range}");
        assert_eq!(
            content_range.unwrap(),
            format!("bytes {from}-{}/{}", to - 1, data.len())
        );
    }
    let ((status, _), content_range) = server
        .raw_with_range("GET", &url, &other, vec![], Some("bytes=999999999-"))
        .await;
    assert_eq!(status, 416);
    assert_eq!(content_range.unwrap(), format!("bytes */{}", data.len()));

    // Expiry removes every part.
    let db = server.state.db.clone().unwrap();
    sqlx::query("UPDATE blobs SET expires_at = now() - interval '1 second'")
        .execute(&db)
        .await
        .unwrap();
    let store = server.state.blobs.clone().unwrap();
    blobs::expire(&db, &store).await.unwrap();
    use object_store::ObjectStoreExt;
    for n in 0..3 {
        let path = object_store::path::Path::from(format!("blobs/{id}/{n}"));
        assert!(store.get(&path).await.is_err());
    }
}

#[sqlx::test]
async fn abandoned_uploads_expire_and_count_against_the_quota(pool: PgPool) {
    let server = TestServer::start_with_limits(
        pool,
        Limits {
            blob_mb_per_day: 20,
            ..Limits::default()
        },
    )
    .await;
    let (_, token) = server.register("ann.01").await;
    let size = blobs::UPLOAD_PART_BYTES as usize + 5;
    let (status, session) = server
        .post(
            "/v1/blobs/uploads",
            Some(&token),
            serde_json::json!({ "size": size }),
        )
        .await;
    assert_eq!(status, 200);
    let id = session["upload_id"].as_str().unwrap().to_owned();
    // The whole size (9 MB) was charged up front: another 12 MB doesn't fit today.
    let (status, _) = server
        .post(
            "/v1/blobs/uploads",
            Some(&token),
            serde_json::json!({ "size": 12 * 1024 * 1024 }),
        )
        .await;
    assert_eq!(status, 429);
    assert_eq!(
        server
            .post(
                "/v1/blobs/uploads",
                Some(&token),
                serde_json::json!({ "size": 0 })
            )
            .await
            .0,
        400
    );
    let first = vec![7u8; blobs::UPLOAD_PART_BYTES as usize];
    let path = format!("/v1/blobs/uploads/{id}/0");
    assert_eq!(server.raw("PUT", &path, &token, first).await.0, 204);

    let db = server.state.db.clone().unwrap();
    sqlx::query("UPDATE blob_uploads SET expires_at = now() - interval '1 second'")
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        server
            .get(&format!("/v1/blobs/uploads/{id}"), Some(&token))
            .await
            .0,
        404
    );
    let store = server.state.blobs.clone().unwrap();
    blobs::expire(&db, &store).await.unwrap();
    let (rows,): (i64,) = sqlx::query_as("SELECT count(*) FROM blob_uploads")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    use object_store::ObjectStoreExt;
    let part = object_store::path::Path::from(format!("blobs/{id}/0"));
    assert!(store.get(&part).await.is_err());
}

fn ciphertext_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn recoverable_request(
    transfer_id: uuid::Uuid,
    size: usize,
    ciphertext: &[u8],
) -> serde_json::Value {
    serde_json::json!({
        "size": size,
        "transfer_id": transfer_id,
        "ciphertext_sha256": ciphertext_sha256(ciphertext),
    })
}

#[sqlx::test]
async fn recoverable_create_reuses_one_upload_and_one_quota_debit(pool: PgPool) {
    let server = TestServer::start_with_limits(
        pool,
        Limits {
            blob_mb_per_day: 1,
            ..Limits::default()
        },
    )
    .await;
    let (device, token) = server.register("ann.01").await;
    assert_eq!(
        server.get("/v1/blobs/capabilities", Some(&token)).await,
        (200, serde_json::json!({"transferIdempotency": 1}))
    );
    let transfer = uuid::Uuid::new_v4();
    let request = recoverable_request(transfer, 4, &[7, 7, 7, 7]);
    let (first_status, first) = server
        .post("/v1/blobs/uploads", Some(&token), request.clone())
        .await;
    assert_eq!(first_status, 200, "{first}");
    // This models a lost create response. The retry must not spend another
    // daily allowance or reserve another physical part object.
    let (retry_status, retry) = server
        .post("/v1/blobs/uploads", Some(&token), request)
        .await;
    assert_eq!(retry_status, 200, "{retry}");
    assert_eq!(retry["upload_id"], first["upload_id"]);
    let db = server.state.db.clone().unwrap();
    let (objects,): (i64,) = sqlx::query_as("SELECT count(*) FROM storage_objects")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(objects, 1);
    let (charged,): (i32,) = sqlx::query_as(
        "SELECT count FROM rate_limits WHERE key = $1 ORDER BY window_start DESC LIMIT 1",
    )
    .bind(format!("blob-mb:{device}"))
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(charged, 1);
    assert_eq!(
        server
            .post(
                "/v1/blobs/uploads",
                Some(&token),
                recoverable_request(uuid::Uuid::new_v4(), 4, &[8, 8, 8, 8]),
            )
            .await
            .0,
        429,
        "a different transfer still consumes the quota"
    );
}

#[sqlx::test]
async fn recoverable_create_conflicts_and_hides_transfers_from_other_devices(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let (_, other) = server.register("ben.01").await;
    assert_eq!(
        server
            .post(
                "/v1/blobs/uploads",
                Some(&token),
                serde_json::json!({
                    "size": 4,
                    "transfer_id": uuid::Uuid::new_v4(),
                    "ciphertext_sha256": "A".repeat(64),
                }),
            )
            .await
            .0,
        400,
        "the digest contract requires lowercase 64-hex"
    );
    let transfer = uuid::Uuid::new_v4();
    let request = recoverable_request(transfer, 4, &[3, 3, 3, 3]);
    let (_, created) = server
        .post("/v1/blobs/uploads", Some(&token), request.clone())
        .await;
    assert!(created["upload_id"].is_string());
    assert_eq!(
        server
            .post(
                "/v1/blobs/uploads",
                Some(&token),
                recoverable_request(transfer, 5, &[3, 3, 3, 3]),
            )
            .await
            .0,
        409
    );
    assert_eq!(
        server
            .post(
                "/v1/blobs/uploads",
                Some(&token),
                recoverable_request(transfer, 4, &[4, 4, 4, 4]),
            )
            .await
            .0,
        409
    );
    assert_eq!(
        server
            .get(&format!("/v1/blobs/transfers/{transfer}"), Some(&other))
            .await
            .0,
        404
    );
    let (status, other_created) = server
        .post("/v1/blobs/uploads", Some(&other), request)
        .await;
    assert_eq!(status, 200, "{other_created}");
    assert_ne!(other_created["upload_id"], created["upload_id"]);
}

#[sqlx::test]
async fn concurrent_recoverable_creates_share_one_upload(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let transfer = uuid::Uuid::new_v4();
    let request = recoverable_request(transfer, 4, &[5, 5, 5, 5]);
    let (left, right) = tokio::join!(
        server.post("/v1/blobs/uploads", Some(&token), request.clone()),
        server.post("/v1/blobs/uploads", Some(&token), request),
    );
    assert_eq!(left.0, 200, "{}", left.1);
    assert_eq!(right.0, 200, "{}", right.1);
    assert_eq!(left.1["upload_id"], right.1["upload_id"]);
    let db = server.state.db.clone().unwrap();
    let (uploads, objects): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM blob_uploads), (SELECT count(*) FROM storage_objects)",
    )
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!((uploads, objects), (1, 1));
}

#[sqlx::test]
async fn recoverable_completion_rejects_ciphertext_that_does_not_match_its_digest(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let transfer = uuid::Uuid::new_v4();
    let (_, session) = server
        .post(
            "/v1/blobs/uploads",
            Some(&token),
            recoverable_request(transfer, 4, &[9, 9, 9, 9]),
        )
        .await;
    let upload_id = session["upload_id"].as_str().unwrap();
    assert_eq!(
        server
            .raw(
                "PUT",
                &format!("/v1/blobs/uploads/{upload_id}/0"),
                &token,
                vec![1, 2, 3, 4],
            )
            .await
            .0,
        204
    );
    assert_eq!(
        server
            .post(
                &format!("/v1/blobs/uploads/{upload_id}/complete"),
                Some(&token),
                serde_json::json!({}),
            )
            .await
            .0,
        409
    );
    assert_eq!(
        server
            .get(&format!("/v1/blobs/transfers/{transfer}"), Some(&token))
            .await,
        (
            200,
            serde_json::json!({"state": "uploading", "upload_id": upload_id})
        )
    );
    let (blobs,): (i64,) = sqlx::query_as("SELECT count(*) FROM blobs")
        .fetch_one(server.state.db.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(blobs, 0, "a mismatched digest never publishes a blob");
}

#[sqlx::test]
async fn live_completion_claim_fences_concurrent_part_writer_and_expiry(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let transfer = uuid::Uuid::new_v4();
    let (_, session) = server
        .post(
            "/v1/blobs/uploads",
            Some(&token),
            recoverable_request(transfer, 4, &[1, 2, 3, 4]),
        )
        .await;
    let upload_id: uuid::Uuid = session["upload_id"].as_str().unwrap().parse().unwrap();
    let db = server.state.db.clone().unwrap();
    sqlx::query(
        "UPDATE blob_uploads SET completion_claim = $2, completion_claimed_at = now()
         WHERE upload_id = $1",
    )
    .bind(upload_id)
    .bind(uuid::Uuid::new_v4())
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(
        server
            .raw(
                "PUT",
                &format!("/v1/blobs/uploads/{upload_id}/0"),
                &token,
                vec![1, 2, 3, 4],
            )
            .await
            .0,
        409
    );
    sqlx::query("UPDATE blob_uploads SET expires_at = now() - interval '1 second'")
        .execute(&db)
        .await
        .unwrap();
    let store = server.state.blobs.clone().unwrap();
    blobs::expire(&db, &store).await.unwrap();
    let (rows,): (i64,) = sqlx::query_as("SELECT count(*) FROM blob_uploads")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(rows, 1, "expiry must not delete a live completion claim");
}

#[sqlx::test]
async fn stale_completion_claim_requires_a_fresh_hash_before_publish(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (device, token) = server.register("ann.01").await;
    let transfer = uuid::Uuid::new_v4();
    let (_, session) = server
        .post(
            "/v1/blobs/uploads",
            Some(&token),
            recoverable_request(transfer, 4, &[1, 2, 3, 4]),
        )
        .await;
    let upload_id: uuid::Uuid = session["upload_id"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        server
            .raw(
                "PUT",
                &format!("/v1/blobs/uploads/{upload_id}/0"),
                &token,
                vec![1, 2, 3, 4],
            )
            .await
            .0,
        204
    );
    let db = server.state.db.clone().unwrap();
    sqlx::query(
        "UPDATE blob_uploads SET completion_claim = $2,
         completion_claimed_at = now() - interval '16 minutes' WHERE upload_id = $1",
    )
    .bind(upload_id)
    .bind(uuid::Uuid::new_v4())
    .execute(&db)
    .await
    .unwrap();
    let (status, completed) = server
        .post(
            &format!("/v1/blobs/uploads/{upload_id}/complete"),
            Some(&token),
            serde_json::json!({}),
        )
        .await;
    assert_eq!(status, 200, "{completed}");
    let (state,): (String,) = sqlx::query_as(
        "SELECT state FROM blob_upload_transfers WHERE device_id = $1 AND transfer_id = $2",
    )
    .bind(device)
    .bind(transfer)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(state, "complete");
}

#[sqlx::test]
async fn concurrent_completers_publish_one_blob(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let transfer = uuid::Uuid::new_v4();
    let (_, session) = server
        .post(
            "/v1/blobs/uploads",
            Some(&token),
            recoverable_request(transfer, 4, &[1, 2, 3, 4]),
        )
        .await;
    let upload_id = session["upload_id"].as_str().unwrap();
    assert_eq!(
        server
            .raw(
                "PUT",
                &format!("/v1/blobs/uploads/{upload_id}/0"),
                &token,
                vec![1, 2, 3, 4],
            )
            .await
            .0,
        204
    );
    let complete = format!("/v1/blobs/uploads/{upload_id}/complete");
    let (left, right) = tokio::join!(
        server.post(&complete, Some(&token), serde_json::json!({})),
        server.post(&complete, Some(&token), serde_json::json!({})),
    );
    assert!(left.0 == 200 || right.0 == 200, "{left:?} {right:?}");
    assert!(matches!(left.0, 200 | 409), "{left:?} {right:?}");
    assert!(matches!(right.0, 200 | 409), "{left:?} {right:?}");
    let (blobs,): (i64,) = sqlx::query_as("SELECT count(*) FROM blobs")
        .fetch_one(server.state.db.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(blobs, 1);
}

#[sqlx::test]
async fn publication_and_recovery_claim_lock_transfer_before_upload(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let transfer = uuid::Uuid::new_v4();
    let (_, session) = server
        .post(
            "/v1/blobs/uploads",
            Some(&token),
            recoverable_request(transfer, 4, &[1, 2, 3, 4]),
        )
        .await;
    let upload_id = session["upload_id"].as_str().unwrap();
    assert_eq!(
        server
            .raw(
                "PUT",
                &format!("/v1/blobs/uploads/{upload_id}/0"),
                &token,
                vec![1, 2, 3, 4],
            )
            .await
            .0,
        204
    );
    let db = server.state.db.as_ref().unwrap();
    // Pause publication after it locks the upload, but before its transfer
    // update. This exposes the old upload/transfer lock inversion reliably.
    sqlx::query(
        "CREATE FUNCTION hold_blob_publication() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN PERFORM pg_advisory_xact_lock(152017::bigint); RETURN NEW; END; $$",
    )
    .execute(db)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER hold_blob_publication BEFORE INSERT ON blobs
         FOR EACH ROW EXECUTE FUNCTION hold_blob_publication()",
    )
    .execute(db)
    .await
    .unwrap();
    let mut gate = db.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(152017::bigint)")
        .execute(&mut *gate)
        .await
        .unwrap();
    let (gate_pid,): (i32,) = sqlx::query_as("SELECT pg_backend_pid()")
        .fetch_one(&mut *gate)
        .await
        .unwrap();
    let complete = format!("/v1/blobs/uploads/{upload_id}/complete");
    let publisher = server.post(&complete, Some(&token), serde_json::json!({}));
    let contender = async {
        let publisher_pid = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let blocked: Option<(i32,)> = sqlx::query_as(
                    "SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                     AND $1 = ANY(pg_blocking_pids(pid))",
                )
                .bind(gate_pid)
                .fetch_optional(db)
                .await
                .unwrap();
                if let Some((pid,)) = blocked {
                    break pid;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("publication must reach the test-only insert gate");
        let retry = server.post(&complete, Some(&token), serde_json::json!({}));
        let release = async {
            let blocked_query = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                loop {
                    let blocked: Option<(String,)> = sqlx::query_as(
                        "SELECT query FROM pg_stat_activity WHERE datname = current_database()
                         AND $1 = ANY(pg_blocking_pids(pid))",
                    )
                    .bind(publisher_pid)
                    .fetch_optional(db)
                    .await
                    .unwrap();
                    if let Some((query,)) = blocked {
                        break query;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the competing claim must wait for publication");
            gate.commit().await.unwrap();
            assert!(
                blocked_query.contains("FROM blob_upload_transfers"),
                "the competing claim must wait on the transfer, not the upload: {blocked_query}"
            );
        };
        let (response, ()) = tokio::join!(retry, release);
        response
    };
    let (left, right) = tokio::join!(publisher, contender);
    assert_eq!(left.0, 200, "{left:?} {right:?}");
    assert_eq!(right.0, 200, "{left:?} {right:?}");
    assert_eq!(left.1["blob_id"], right.1["blob_id"]);
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM blobs")
        .fetch_one(db)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test]
async fn recoverable_completion_and_expiry_keep_transfer_fences(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    let transfer = uuid::Uuid::new_v4();
    let request = recoverable_request(transfer, 4, &[1, 2, 3, 4]);
    let (_, session) = server
        .post("/v1/blobs/uploads", Some(&token), request.clone())
        .await;
    let upload_id = session["upload_id"].as_str().unwrap();
    assert_eq!(
        server
            .raw(
                "PUT",
                &format!("/v1/blobs/uploads/{upload_id}/0"),
                &token,
                vec![1, 2, 3, 4],
            )
            .await
            .0,
        204
    );
    let complete_url = format!("/v1/blobs/uploads/{upload_id}/complete");
    let (status, completed) = server
        .post(&complete_url, Some(&token), serde_json::json!({}))
        .await;
    assert_eq!(status, 200, "{completed}");
    // This models a lost completion response after the session row is gone.
    let (retry_status, retry) = server
        .post(&complete_url, Some(&token), serde_json::json!({}))
        .await;
    assert_eq!(retry_status, 200, "{retry}");
    assert_eq!(retry["blob_id"], completed["blob_id"]);
    assert_eq!(
        server
            .get(&format!("/v1/blobs/transfers/{transfer}"), Some(&token))
            .await,
        (
            200,
            serde_json::json!({"state": "complete", "blob_id": completed["blob_id"]})
        )
    );

    let db = server.state.db.clone().unwrap();
    sqlx::query("UPDATE blobs SET expires_at = now() - interval '1 second'")
        .execute(&db)
        .await
        .unwrap();
    let store = server.state.blobs.clone().unwrap();
    blobs::expire(&db, &store).await.unwrap();
    assert_eq!(
        server
            .get(&format!("/v1/blobs/transfers/{transfer}"), Some(&token))
            .await
            .0,
        409
    );
    assert_eq!(
        server
            .post("/v1/blobs/uploads", Some(&token), request)
            .await
            .0,
        409,
        "the completed and expired key stays a replay fence"
    );
}

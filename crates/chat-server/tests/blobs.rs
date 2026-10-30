//! Encrypted attachments (FR-MED-2/3, ADR-0023).
mod support;

use chat_server::{blobs, limits::Limits};
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

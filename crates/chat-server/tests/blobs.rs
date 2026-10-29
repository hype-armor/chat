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

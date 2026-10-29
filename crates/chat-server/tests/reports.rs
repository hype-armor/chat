//! User reports (FR-ID-8).
mod support;

use chat_server::limits::Limits;
use serde_json::json;
use sqlx::PgPool;
use support::TestServer;
use uuid::Uuid;

#[sqlx::test]
async fn reports_are_stored_with_chosen_evidence(pool: PgPool) {
    let server = TestServer::start_with_limits(
        pool,
        Limits {
            reports_per_day: 2,
            ..Limits::default()
        },
    )
    .await;
    let (_, token) = server.register("+15550005001").await;
    server.register("+15550005002").await;
    let (_, spammer) = server
        .post(
            "/v1/lookup",
            Some(&token),
            json!({ "phone": "+15550005002" }),
        )
        .await;
    let account = spammer["account_id"].clone();

    let report = json!({
        "account_id": account,
        "reason": "spam",
        "messages": [{ "text": "buy now", "sent_at_ms": 1_700_000_000_000u64 }],
    });
    let (status, _) = server.post("/v1/reports", None, report.clone()).await;
    assert_eq!(status, 401);
    let (status, _) = server
        .post("/v1/reports", Some(&token), report.clone())
        .await;
    assert_eq!(status, 204);
    let (reason, text): (String, String) =
        sqlx::query_as("SELECT reason, evidence->0->>'text' FROM reports")
            .fetch_one(server.state.db.as_ref().unwrap())
            .await
            .unwrap();
    assert_eq!((reason.as_str(), text.as_str()), ("spam", "buy now"));

    // Unknown accounts and reasons, oversized evidence, and the daily limit.
    let unknown = json!({ "account_id": Uuid::new_v4(), "reason": "spam" });
    assert_eq!(
        server.post("/v1/reports", Some(&token), unknown).await.0,
        404
    );
    let bad = json!({ "account_id": account, "reason": "nope" });
    assert_eq!(server.post("/v1/reports", Some(&token), bad).await.0, 422);
    let long = json!({ "account_id": account, "reason": "other",
        "messages": [{ "text": "x".repeat(4001), "sent_at_ms": 0 }] });
    assert_eq!(server.post("/v1/reports", Some(&token), long).await.0, 400);
    assert_eq!(
        server.post("/v1/reports", Some(&token), report).await.0,
        429
    );
}

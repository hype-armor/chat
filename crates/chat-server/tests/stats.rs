//! Opt-in call statistics (ADR-0032).
mod support;

use serde_json::json;
use sqlx::PgPool;
use support::TestServer;

#[sqlx::test]
async fn call_stats_are_counted_without_identity(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let report = json!({
        "direct": { "connected": 9, "failed": 1, "setup_seconds": [0.8, 1.2] },
        "group": { "connected": 2 }
    });
    let (status, _) = server.post("/v1/stats/calls", None, report).await;
    assert_eq!(status, 204);
    let text = server.state.metrics.render();
    assert!(
        text.contains(r#"chat_calls_total{kind="direct",outcome="connected"} 9"#),
        "{text}"
    );
    assert!(text.contains(r#"chat_calls_total{kind="direct",outcome="failed"} 1"#));
    assert!(text.contains(r#"chat_calls_total{kind="group",outcome="connected"} 2"#));
    assert!(text.contains(r#"chat_call_setup_seconds_count{kind="direct"} 2"#));

    let (status, _) = server
        .post(
            "/v1/stats/calls",
            None,
            json!({ "direct": { "connected": 100000 } }),
        )
        .await;
    assert_eq!(status, 400);
    let (status, _) = server
        .post(
            "/v1/stats/calls",
            None,
            json!({ "direct": { "setup_seconds": [-1.0] } }),
        )
        .await;
    assert_eq!(status, 400);
    let (status, _) = server
        .post("/v1/stats/calls", None, json!({ "who": "me" }))
        .await;
    assert_eq!(status, 422);
}

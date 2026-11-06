//! TURN credentials are limited per device (ADR-0028): relayed media costs
//! money, so one device cannot mint credentials without end.
mod support;

use chat_server::limits::Limits;
use sqlx::PgPool;
use support::TestServer;

#[sqlx::test]
async fn turn_credentials_are_limited_per_device(pool: PgPool) {
    let server = TestServer::start_with_limits(
        pool,
        Limits {
            turn_credentials_per_day: 1,
            ..Limits::default()
        },
    )
    .await;
    let (_, phone) = server.register("u5550009102.10").await;

    let (status, body) = server.get("/v1/turn", Some(&phone)).await;
    assert_eq!(status, 200, "{body}");
    let (status, _) = server.get("/v1/turn", Some(&phone)).await;
    assert_eq!(status, 429, "the second request in a day is refused");

    // The budget is per device, not per account or across the service.
    let (_, tablet) = server.register("u5550009103.10").await;
    let (status, body) = server.get("/v1/turn", Some(&tablet)).await;
    assert_eq!(status, 200, "another device has its own budget: {body}");
}

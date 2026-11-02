//! The service-wide sign-up quota is charged only for sign-ups that are
//! allowed to create an account (ADR-0021): anonymous requests without a
//! valid invite must not be able to spend it.
mod support;

use base64::{Engine, engine::general_purpose::STANDARD};
use chat_server::invites;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::TestServer;

fn sign_up(username: &str, invite: Option<&str>) -> Value {
    json!({ "username": username, "invite": invite, "identity_key": STANDARD.encode(b"k") })
}

#[sqlx::test]
async fn anonymous_sign_ups_do_not_spend_the_service_quota(pool: PgPool) {
    let mut server = TestServer::start(pool).await;
    // Production configuration: sign-up needs an invite.
    server.state.open_registration = false;
    let db = server.state.db.clone().unwrap();

    // Three attempts an anonymous client can make: no invite at all, a
    // malformed invite, and a well-formed code that does not exist.
    for invite in [None, Some("nope"), Some("aaaaaaaaaaaaaaaaaaaaaa")] {
        let (status, _) = server
            .post("/v1/register", None, sign_up("u5550009001.10", invite))
            .await;
        assert_ne!(status, 200, "no account without a valid invite: {invite:?}");
    }

    // None of them may have used up the service's daily sign-up budget.
    let (rows,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM rate_limits WHERE key = 'register-all'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(rows, 0, "refused sign-ups must not charge 'register-all'");
}

#[sqlx::test]
async fn a_valid_invite_spends_one_service_quota_unit(pool: PgPool) {
    let mut server = TestServer::start(pool).await;
    server.state.open_registration = false;
    let db = server.state.db.clone().unwrap();

    let code = invites::create_invite(&db, None).await.unwrap();
    let (status, body) = server
        .post("/v1/register", None, sign_up("u5550009002.10", Some(&code)))
        .await;
    assert_eq!(status, 200, "{body}");

    let (count,): (i32,) =
        sqlx::query_as("SELECT count FROM rate_limits WHERE key = 'register-all'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 1, "one sign-up, one unit");

    // A sign-up that fails later (taken username) rolls its unit back.
    let code = invites::create_invite(&db, None).await.unwrap();
    let (status, _) = server
        .post("/v1/register", None, sign_up("u5550009002.10", Some(&code)))
        .await;
    assert_eq!(status, 409);
    let (count,): (i32,) =
        sqlx::query_as("SELECT count FROM rate_limits WHERE key = 'register-all'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(count, 1, "a failed sign-up must not charge the quota");
}

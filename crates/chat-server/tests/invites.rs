//! Invite-only sign-up (ADR-0021).
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
async fn sign_up_needs_a_valid_unused_invite(pool: PgPool) {
    let mut server = TestServer::start(pool).await;
    server.state.open_registration = false;
    let db = server.state.db.clone().unwrap();

    let (status, _) = server
        .post("/v1/register", None, sign_up("ann.01", None))
        .await;
    assert_eq!(status, 403, "no invite");
    let (status, _) = server
        .post("/v1/register", None, sign_up("ann.01", Some("nope")))
        .await;
    assert_eq!(status, 400, "malformed");

    // The operator's invite (chat-server create-invite) signs up the first user.
    let code = invites::create_invite(&db, None).await.unwrap();
    let (status, ann) = server
        .post("/v1/register", None, sign_up("ann.01", Some(&code)))
        .await;
    assert_eq!(status, 200, "{ann}");
    let (status, _) = server
        .post("/v1/register", None, sign_up("ben.01", Some(&code)))
        .await;
    assert_eq!(status, 403, "single use");

    // Ann invites Ben. Nothing records who invited whom once it is used.
    let ann_token = ann["token"].as_str().unwrap();
    let (status, invite) = server.post("/v1/invites", Some(ann_token), json!({})).await;
    assert_eq!(status, 200, "{invite}");
    assert_eq!(invite["expires_in_days"], 7);
    let code = invite["code"].as_str().unwrap();
    let (status, _) = server
        .post("/v1/register", None, sign_up("ben.01", Some(code)))
        .await;
    assert_eq!(status, 200);
    let (left,): (i64,) = sqlx::query_as("SELECT count(*) FROM invites")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(left, 0);

    // A taken username doesn't use up the invite.
    let (_, invite) = server.post("/v1/invites", Some(ann_token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_owned();
    let (status, _) = server
        .post("/v1/register", None, sign_up("ben.01", Some(&code)))
        .await;
    assert_eq!(status, 409);
    let (status, _) = server
        .post("/v1/register", None, sign_up("cat.01", Some(&code)))
        .await;
    assert_eq!(status, 200);

    // Expired invites don't work.
    let code = invites::create_invite(&db, None).await.unwrap();
    sqlx::query("UPDATE invites SET expires_at = now() - interval '1 second'")
        .execute(&db)
        .await
        .unwrap();
    let (status, _) = server
        .post("/v1/register", None, sign_up("dee.01", Some(&code)))
        .await;
    assert_eq!(status, 403);
}

#[sqlx::test]
async fn invites_are_limited_per_account(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_, token) = server.register("ann.01").await;
    for _ in 0..5 {
        assert_eq!(
            server.post("/v1/invites", Some(&token), json!({})).await.0,
            200
        );
    }
    // Five unused invites at once.
    assert_eq!(
        server.post("/v1/invites", Some(&token), json!({})).await.0,
        429
    );
    assert_eq!(server.post("/v1/invites", None, json!({})).await.0, 401);
}

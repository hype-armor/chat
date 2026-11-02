//! Key packages are leased to one claimer, not deleted (audit finding M3).
mod support;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::TestServer;
use uuid::Uuid;

/// Uploads `n` fake key packages for `token`.
async fn upload(server: &TestServer, token: &str, n: usize) {
    let kps: Vec<String> = (0..n)
        .map(|i| STANDARD.encode(format!("kp-{i}").as_bytes()))
        .collect();
    let (status, body) = server
        .post("/v1/keys", Some(token), json!({ "key_packages": kps }))
        .await;
    assert_eq!(status, 204, "{body}");
}

/// Claims one package for `device`; returns the claimed package map.
async fn claim(server: &TestServer, token: &str, device: Uuid) -> Value {
    let (status, body) = server
        .post(
            "/v1/keys/claim",
            Some(token),
            json!({ "device_ids": [device] }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    body["key_packages"].clone()
}

async fn stored(server: &TestServer, device: Uuid) -> i64 {
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM key_packages WHERE device_id = $1")
        .bind(device)
        .fetch_one(server.state.db.as_ref().unwrap())
        .await
        .unwrap();
    n
}

#[sqlx::test]
async fn claim_keeps_the_row(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (bob, bob_token) = server.register("u5550009001.10").await;
    let (_, alice_token) = server.register("u5550009002.10").await;
    upload(&server, &bob_token, 5).await;
    assert_eq!(stored(&server, bob).await, 5);

    for _ in 0..3 {
        let packages = claim(&server, &alice_token, bob).await;
        assert!(
            packages.get(bob.to_string()).is_some(),
            "claim gives a package: {packages}"
        );
    }
    // A lease does not remove the package from the table.
    assert_eq!(stored(&server, bob).await, 5);
}

#[sqlx::test]
async fn a_claimer_stops_at_three_leases(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (bob, bob_token) = server.register("u5550009011.10").await;
    let (_, alice_token) = server.register("u5550009012.10").await;
    let (_, carol_token) = server.register("u5550009013.10").await;
    upload(&server, &bob_token, 5).await;

    for _ in 0..3 {
        let packages = claim(&server, &alice_token, bob).await;
        assert!(packages.get(bob.to_string()).is_some(), "{packages}");
    }
    // The fourth claim finds no package for alice, though two are unleased.
    let fourth = claim(&server, &alice_token, bob).await;
    assert_eq!(fourth, json!({}), "alice holds three leases already");

    // Another claimer is not blocked by alice's leases.
    let carols = claim(&server, &carol_token, bob).await;
    assert!(carols.get(bob.to_string()).is_some(), "{carols}");
}

#[sqlx::test]
async fn count_excludes_leased_packages(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (bob, bob_token) = server.register("u5550009021.10").await;
    let (_, alice_token) = server.register("u5550009022.10").await;
    let count = |token: &str| {
        let server = &server;
        let token = token.to_owned();
        async move {
            let (status, body) = server.get("/v1/keys/count", Some(&token)).await;
            assert_eq!(status, 200, "{body}");
            body["available"].as_u64().unwrap()
        }
    };
    upload(&server, &bob_token, 5).await;
    assert_eq!(count(&bob_token).await, 5);

    for _ in 0..3 {
        claim(&server, &alice_token, bob).await;
    }
    // Leased packages are not available to anyone else, but they stay stored.
    assert_eq!(count(&bob_token).await, 2);
    assert_eq!(stored(&server, bob).await, 5);
}

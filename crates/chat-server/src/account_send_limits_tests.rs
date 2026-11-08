//! Persistent send budgets shared by an account's devices and server replicas.
#[path = "../tests/support/mod.rs"]
mod support;

use crate::{
    delivery::{self, Send, SendOutcome},
    error::ApiError,
    limits::Limits,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope, SendEnvelope, client_frame, server_frame},
};
use serde_json::json;
use sqlx::PgPool;
use support::{Client, TestServer};
use uuid::Uuid;

fn envelope(conversation: &[u8], kind: ContentType) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION,
        conversation_id: conversation.to_vec(),
        epoch: 0,
        content_type: kind.into(),
        ciphertext: b"ciphertext".to_vec(),
        message_id: Uuid::new_v4().as_bytes().to_vec(),
    }
}

async fn send(
    pool: &PgPool,
    caps: &Limits,
    sender: Uuid,
    env: &Envelope,
    recipients: &[Uuid],
) -> Result<SendOutcome, ApiError> {
    delivery::send(
        pool,
        caps,
        Send {
            sender,
            envelope: env,
            recipients,
            welcome: None,
            members: &[],
        },
    )
    .await
}

async fn ws_send(client: &mut Client, to: Uuid) -> Result<bool, u32> {
    let request = SendEnvelope {
        envelope: Some(envelope(b"shared", ContentType::Application)),
        recipient_devices: vec![to.as_bytes().to_vec()],
        // Silent sends must use the same account budget.
        silent: true,
        ..Default::default()
    };
    match client.request(client_frame::Body::Send(request)).await.body {
        Some(server_frame::Body::SendResult(r)) => Ok(r.accepted),
        Some(server_frame::Body::Error(e)) => Err(e.code),
        other => panic!("unexpected send response: {other:?}"),
    }
}

async fn link(server: &TestServer, token: &str) -> (Uuid, String) {
    let (status, body) = server.post("/v1/link/start", None, json!({})).await;
    assert_eq!(status, 200);
    let code = body["code"].as_str().unwrap();
    assert_eq!(
        server
            .post("/v1/link/approve", Some(token), json!({ "code": code }))
            .await
            .0,
        204
    );
    let (status, body) = server
        .post(
            "/v1/link/complete",
            None,
            json!({ "code": code, "identity_key": STANDARD.encode(b"linked-key") }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    (
        body["device_id"].as_str().unwrap().parse().unwrap(),
        body["token"].as_str().unwrap().to_owned(),
    )
}

async fn account(pool: &PgPool, device: Uuid) -> Uuid {
    sqlx::query_scalar("SELECT account_id FROM devices WHERE device_id = $1")
        .bind(device)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn count(pool: &PgPool, key: &str) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(sum(count), 0)::bigint FROM rate_limits WHERE key = $1")
        .bind(key)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn account_count(pool: &PgPool, device: Uuid) -> i64 {
    count(
        pool,
        &format!("send-account:{}", account(pool, device).await),
    )
    .await
}

async fn policy(pool: &PgPool, device: Uuid, limit: i32) {
    sqlx::query(
        "INSERT INTO account_send_limits (account_id, sends_per_minute) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET sends_per_minute = EXCLUDED.sends_per_minute",
    )
    .bind(account(pool, device).await)
    .bind(limit)
    .execute(pool)
    .await
    .unwrap();
}

async fn claim(server: &TestServer, token: &str, recipient: Uuid, recipient_token: &str) {
    assert_eq!(
        server
            .post(
                "/v1/keys",
                Some(recipient_token),
                json!({ "key_packages": [STANDARD.encode(b"key-package")] }),
            )
            .await
            .0,
        204
    );
    assert_eq!(
        server
            .post(
                "/v1/keys/claim",
                Some(token),
                json!({ "device_ids": [recipient] }),
            )
            .await
            .0,
        200
    );
}

#[sqlx::test]
async fn linked_devices_share_a_persistent_budget_across_replicas(pool: PgPool) {
    let caps = Limits {
        sends_per_account_per_minute: 2,
        ..Limits::default()
    };
    let first = TestServer::start_with_limits(pool.clone(), caps.clone()).await;
    let (alice, token) = first.register("sendalice.01").await;
    let (linked, linked_token) = link(&first, &token).await;
    let (bob, bob_token) = first.register("sendbob.01").await;
    first.admit(b"shared", &[alice, linked, bob]).await;
    // A separate AppState has fresh device buckets but uses the same database.
    let second = TestServer::start_with_limits(pool.clone(), caps).await;
    assert!(!std::sync::Arc::ptr_eq(
        &first.state.send_buckets,
        &second.state.send_buckets
    ));
    let mut alice_ws = first.connect(&token).await;
    let mut linked_ws = second.connect(&linked_token).await;
    assert_eq!(ws_send(&mut alice_ws, bob).await, Ok(true));
    assert_eq!(ws_send(&mut linked_ws, bob).await, Ok(true));
    assert_eq!(ws_send(&mut alice_ws, bob).await, Err(429));
    assert_eq!(ws_send(&mut linked_ws, bob).await, Err(429));
    assert_eq!(account_count(&pool, alice).await, 2);
    // Another account has an independent budget.
    let mut bob_ws = second.connect(&bob_token).await;
    assert_eq!(ws_send(&mut bob_ws, alice).await, Ok(true));
    assert_eq!(account_count(&pool, bob).await, 1);
}

#[sqlx::test]
async fn concurrent_linked_sends_cannot_exceed_one_account_budget(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (alice, token) = server.register("racealice.01").await;
    let (linked, _) = link(&server, &token).await;
    let (bob, _) = server.register("racebob.01").await;
    let (carol, _) = server.register("racecarol.01").await;
    server.admit(b"race-one", &[alice, bob]).await;
    server.admit(b"race-two", &[linked, carol]).await;
    let caps = Limits {
        sends_per_account_per_minute: 1,
        ..Limits::default()
    };
    let first_env = envelope(b"race-one", ContentType::Application);
    let second_env = envelope(b"race-two", ContentType::Application);
    let first_to = [bob];
    let second_to = [carol];
    // Distinct conversations and recipient locks leave only the account
    // counter to serialize these two independent database transactions.
    let (first, second) = tokio::join!(
        send(&pool, &caps, alice, &first_env, &first_to),
        send(&pool, &caps, linked, &second_env, &second_to),
    );
    let results = [first, second];
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Ok(SendOutcome::Accepted { .. })))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(ApiError::TooManyRequests(_))))
            .count(),
        1
    );
    assert_eq!(account_count(&pool, alice).await, 1);
}

#[sqlx::test]
async fn account_rejection_rolls_back_commit_membership_leases_and_queue(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (alice, token) = server.register("rollbackalice.01").await;
    let (bob, _) = server.register("rollbackbob.01").await;
    let (carol, carol_token) = server.register("rollbackcarol.01").await;
    server.admit(b"rollback", &[alice, bob]).await;
    claim(&server, &token, carol, &carol_token).await;
    let caps = Limits {
        sends_per_account_per_minute: 1,
        ..Limits::default()
    };
    let application = envelope(b"rollback", ContentType::Application);
    assert!(matches!(
        send(&pool, &caps, alice, &application, &[bob]).await,
        Ok(SendOutcome::Accepted { .. })
    ));
    let bytes_before = count(&pool, &format!("send-bytes:{alice}")).await;
    let commit = envelope(b"rollback", ContentType::Handshake);
    let welcome = envelope(b"rollback", ContentType::Welcome);
    let members = [alice, carol].map(|id| id.as_bytes().to_vec());
    let result = delivery::send(
        &pool,
        &caps,
        Send {
            sender: alice,
            envelope: &commit,
            recipients: &[bob],
            welcome: Some((&welcome, &[carol])),
            members: &members,
        },
    )
    .await;
    assert!(matches!(result, Err(ApiError::TooManyRequests(_))));
    assert_eq!(account_count(&pool, alice).await, 1);
    assert_eq!(
        count(&pool, &format!("send-bytes:{alice}")).await,
        bytes_before
    );
    let epochs: i64 = sqlx::query_scalar("SELECT count(*) FROM group_epochs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(epochs, 0, "rejected commit must not advance the epoch");
    let members: Vec<Uuid> =
        sqlx::query_scalar("SELECT device_id FROM conversation_members WHERE conversation_id = $1")
            .bind(b"rollback".as_slice())
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(members.len(), 2);
    assert!(members.contains(&alice) && members.contains(&bob));
    let leases: i64 = sqlx::query_scalar("SELECT count(*) FROM key_packages WHERE claimed_by = $1")
        .bind(alice)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(leases, 1, "rejected welcome must not consume a lease");
    assert!(delivery::pending(&pool, carol, 0).await.unwrap().is_empty());
    assert_eq!(delivery::pending(&pool, bob, 0).await.unwrap().len(), 1);
}

#[sqlx::test]
async fn later_byte_rejection_rolls_back_the_account_counter(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (alice, _) = server.register("bytesalice.01").await;
    let (bob, _) = server.register("bytesbob.01").await;
    server.admit(b"bytes", &[alice, bob]).await;
    let mut caps = Limits {
        sends_per_account_per_minute: 1,
        send_mb_per_day: 0,
        ..Limits::default()
    };
    let env = envelope(b"bytes", ContentType::Application);
    assert!(matches!(
        send(&pool, &caps, alice, &env, &[bob]).await,
        Err(ApiError::TooManyRequests(_))
    ));
    assert_eq!(account_count(&pool, alice).await, 0);
    assert_eq!(count(&pool, &format!("send-bytes:{alice}")).await, 0);
    caps.send_mb_per_day = 1;
    assert!(matches!(
        send(&pool, &caps, alice, &env, &[bob]).await,
        Ok(SendOutcome::Accepted { .. })
    ));
    assert_eq!(account_count(&pool, alice).await, 1);
}

#[sqlx::test]
async fn unauthorized_attempts_cannot_spend_persistent_send_budgets(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (alice, _) = server.register("authalice.01").await;
    let (bob, _) = server.register("authbob.01").await;
    let (outsider, _) = server.register("authoutsider.01").await;
    server.admit(b"authorized", &[alice, bob]).await;
    let caps = Limits {
        sends_per_account_per_minute: 1,
        ..Limits::default()
    };
    let application = envelope(b"authorized", ContentType::Application);
    assert!(matches!(
        send(&pool, &caps, outsider, &application, &[bob]).await,
        Err(ApiError::Forbidden(_))
    ));
    assert!(matches!(
        send(&pool, &caps, alice, &application, &[outsider]).await,
        Err(ApiError::Forbidden(_))
    ));
    let welcome = envelope(b"unclaimed", ContentType::Welcome);
    assert!(matches!(
        send(&pool, &caps, alice, &welcome, &[outsider]).await,
        Err(ApiError::Forbidden(_))
    ));
    let commit = envelope(b"authorized", ContentType::Handshake);
    let welcome = envelope(b"authorized", ContentType::Welcome);
    let result = delivery::send(
        &pool,
        &caps,
        Send {
            sender: alice,
            envelope: &commit,
            recipients: &[bob],
            welcome: Some((&welcome, &[outsider])),
            members: &[],
        },
    )
    .await;
    assert!(matches!(result, Err(ApiError::Forbidden(_))));
    for device in [alice, outsider] {
        assert_eq!(account_count(&pool, device).await, 0);
        assert_eq!(count(&pool, &format!("send-bytes:{device}")).await, 0);
    }
    assert!(delivery::pending(&pool, bob, 0).await.unwrap().is_empty());
    assert!(matches!(
        send(&pool, &caps, alice, &application, &[bob]).await,
        Ok(SendOutcome::Accepted { .. })
    ));
    assert_eq!(account_count(&pool, alice).await, 1);
}

#[sqlx::test]
async fn zero_override_blocks_every_send_path_and_welcome_side_effect(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (alice, token) = server.register("zeroalice.01").await;
    let (bob, bob_token) = server.register("zerobob.01").await;
    server.admit(b"zero", &[alice, bob]).await;
    claim(&server, &token, bob, &bob_token).await;
    policy(&pool, alice, 0).await;
    let caps = Limits::default();
    for kind in [
        ContentType::Application,
        ContentType::Proposal,
        ContentType::Handshake,
        ContentType::Welcome,
    ] {
        let env = envelope(b"zero", kind);
        assert!(
            matches!(
                send(&pool, &caps, alice, &env, &[bob]).await,
                Err(ApiError::TooManyRequests(_))
            ),
            "{kind:?}"
        );
    }
    // A standalone welcome that would create membership must roll it back.
    let env = envelope(b"new-zero", ContentType::Welcome);
    assert!(matches!(
        send(&pool, &caps, alice, &env, &[bob]).await,
        Err(ApiError::TooManyRequests(_))
    ));
    let members: i64 =
        sqlx::query_scalar("SELECT count(*) FROM conversation_members WHERE conversation_id = $1")
            .bind(b"new-zero".as_slice())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(members, 0);
    assert_eq!(account_count(&pool, alice).await, 0);
    let leases: i64 = sqlx::query_scalar("SELECT count(*) FROM key_packages WHERE claimed_by = $1")
        .bind(alice)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(leases, 1);
    assert!(delivery::pending(&pool, bob, 0).await.unwrap().is_empty());
}

#[sqlx::test]
async fn overrides_replace_defaults_and_deletion_restores_inheritance(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (alice, _) = server.register("policyalice.01").await;
    let (bob, _) = server.register("policybob.01").await;
    server.admit(b"policy", &[alice, bob]).await;
    let caps = Limits {
        sends_per_account_per_minute: 1,
        ..Limits::default()
    };
    policy(&pool, alice, 2).await;
    for _ in 0..2 {
        let env = envelope(b"policy", ContentType::Application);
        assert!(matches!(
            send(&pool, &caps, alice, &env, &[bob]).await,
            Ok(SendOutcome::Accepted { .. })
        ));
    }
    let env = envelope(b"policy", ContentType::Application);
    assert!(matches!(
        send(&pool, &caps, alice, &env, &[bob]).await,
        Err(ApiError::TooManyRequests(_))
    ));
    sqlx::query("DELETE FROM account_send_limits WHERE account_id = $1")
        .bind(account(&pool, alice).await)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        matches!(
            send(&pool, &caps, alice, &env, &[bob]).await,
            Err(ApiError::TooManyRequests(_))
        ),
        "absent override inherits limit 1"
    );
    assert_eq!(account_count(&pool, alice).await, 2);
}

#[sqlx::test]
async fn a_new_fixed_window_gets_a_fresh_account_budget(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (alice, _) = server.register("windowalice.01").await;
    let (bob, _) = server.register("windowbob.01").await;
    server.admit(b"window", &[alice, bob]).await;
    let caps = Limits {
        sends_per_account_per_minute: 1,
        ..Limits::default()
    };
    let env = envelope(b"window", ContentType::Application);
    assert!(matches!(
        send(&pool, &caps, alice, &env, &[bob]).await,
        Ok(SendOutcome::Accepted { .. })
    ));
    assert!(matches!(
        send(&pool, &caps, alice, &env, &[bob]).await,
        Err(ApiError::TooManyRequests(_))
    ));
    // Move the used counter to the previous minute without a clock delay.
    sqlx::query(
        "UPDATE rate_limits SET window_start =
         to_timestamp(floor(extract(epoch FROM now()) / 60) * 60) - interval '1 minute'
         WHERE key = $1",
    )
    .bind(format!("send-account:{}", account(&pool, alice).await))
    .execute(&pool)
    .await
    .unwrap();
    let env = envelope(b"window", ContentType::Application);
    assert!(matches!(
        send(&pool, &caps, alice, &env, &[bob]).await,
        Ok(SendOutcome::Accepted { .. })
    ));
    assert_eq!(account_count(&pool, alice).await, 2);
}

#[sqlx::test]
async fn bundled_welcome_costs_one_request_and_epoch_conflicts_cost_nothing(pool: PgPool) {
    let server = TestServer::start(pool.clone()).await;
    let (alice, token) = server.register("bundlealice.01").await;
    let (bob, _) = server.register("bundlebob.01").await;
    let (carol, carol_token) = server.register("bundlecarol.01").await;
    server.admit(b"bundle", &[alice, bob]).await;
    claim(&server, &token, carol, &carol_token).await;
    let caps = Limits {
        sends_per_account_per_minute: 1,
        ..Limits::default()
    };
    let commit = envelope(b"bundle", ContentType::Handshake);
    let welcome = envelope(b"bundle", ContentType::Welcome);
    let result = delivery::send(
        &pool,
        &caps,
        Send {
            sender: alice,
            envelope: &commit,
            recipients: &[bob],
            welcome: Some((&welcome, &[carol])),
            members: &[],
        },
    )
    .await;
    assert!(matches!(result, Ok(SendOutcome::Accepted { .. })));
    assert_eq!(account_count(&pool, alice).await, 1);
    assert_eq!(delivery::pending(&pool, bob, 0).await.unwrap().len(), 1);
    assert_eq!(delivery::pending(&pool, carol, 0).await.unwrap().len(), 1);
    assert_eq!(
        send(&pool, &caps, alice, &commit, &[bob]).await.unwrap(),
        SendOutcome::EpochConflict
    );
    assert_eq!(account_count(&pool, alice).await, 1);
}

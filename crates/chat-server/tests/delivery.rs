mod support;

use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use chat_core::{
    envelope,
    mls::{Conversation, Device, Received},
};
use chat_proto::{
    PROTOCOL_VERSION,
    v1::{Ack, ContentType, Envelope, Ping, SendEnvelope, SendResult, client_frame, server_frame},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use support::{Client, TestServer};
use uuid::Uuid;

fn message_id() -> Vec<u8> {
    Uuid::new_v4().as_bytes().to_vec()
}

async fn send(client: &mut Client, env: Envelope, to: &[Uuid]) -> SendResult {
    let reply = client
        .request(client_frame::Body::Send(SendEnvelope {
            envelope: Some(env),
            recipient_devices: to.iter().map(|d| d.as_bytes().to_vec()).collect(),
            ..Default::default()
        }))
        .await;
    match reply.body {
        Some(server_frame::Body::SendResult(r)) => r,
        other => panic!("unexpected reply: {other:?}"),
    }
}

async fn expect_delivery(client: &mut Client) -> Envelope {
    match client
        .next_frame(Duration::from_secs(5))
        .await
        .expect("delivery")
        .body
    {
        Some(server_frame::Body::Deliver(env)) => env,
        other => panic!("expected a delivery, got {other:?}"),
    }
}

#[sqlx::test]
async fn phone_verification(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let phone = "+15550001111";

    let (status, _) = server
        .post(
            "/v1/auth/request-code",
            None,
            json!({ "phone": "5550001111" }),
        )
        .await;
    assert_eq!(status, 400);

    let (status, _) = server
        .post("/v1/auth/request-code", None, json!({ "phone": phone }))
        .await;
    assert_eq!(status, 204);
    let key = STANDARD.encode(b"k");
    let (status, _) = server
        .post(
            "/v1/auth/verify",
            None,
            json!({ "phone": phone, "code": "000000x", "identity_key": key }),
        )
        .await;
    assert_eq!(status, 401);

    let code = server.last_code(phone);
    let (status, first) = server
        .post(
            "/v1/auth/verify",
            None,
            json!({ "phone": phone, "code": code, "identity_key": key }),
        )
        .await;
    assert_eq!(status, 200);
    // Codes are single-use.
    let (status, _) = server
        .post(
            "/v1/auth/verify",
            None,
            json!({ "phone": phone, "code": code, "identity_key": key }),
        )
        .await;
    assert_eq!(status, 401);

    // A second device joins the same account.
    let (_, second_token) = server.register(phone).await;
    let (status, lookup) = server
        .post("/v1/lookup", Some(&second_token), json!({ "phone": phone }))
        .await;
    assert_eq!(status, 200);
    assert_eq!(lookup["account_id"], first["account_id"]);
    assert_eq!(lookup["device_ids"].as_array().unwrap().len(), 2);

    // Third request within 15 minutes is still allowed, the fourth is not.
    server
        .post("/v1/auth/request-code", None, json!({ "phone": phone }))
        .await;
    let (status, _) = server
        .post("/v1/auth/request-code", None, json!({ "phone": phone }))
        .await;
    assert_eq!(status, 429);

    let (status, _) = server
        .post("/v1/lookup", Some("bogus"), json!({ "phone": phone }))
        .await;
    assert_eq!(status, 401);
}

#[sqlx::test]
async fn two_users_exchange_an_encrypted_message(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (_alice_dev, alice_token) = server.register("+15550002222").await;
    let (bob_dev, bob_token) = server.register("+15550003333").await;
    let alice = Device::new(b"alice").unwrap();
    let bob = Device::new(b"bob").unwrap();

    // Bob publishes a key package; Alice finds Bob and claims it.
    let kp = STANDARD.encode(bob.key_package().unwrap());
    let (status, _) = server
        .post(
            "/v1/keys",
            Some(&bob_token),
            json!({ "key_packages": [kp] }),
        )
        .await;
    assert_eq!(status, 204);
    let (_, lookup) = server
        .post(
            "/v1/lookup",
            Some(&alice_token),
            json!({ "phone": "+15550003333" }),
        )
        .await;
    assert_eq!(lookup["device_ids"][0], bob_dev.to_string());
    let (status, claimed) = server
        .post(
            "/v1/keys/claim",
            Some(&alice_token),
            json!({ "device_ids": [bob_dev] }),
        )
        .await;
    assert_eq!(status, 200, "{claimed}");
    let bob_kp = STANDARD
        .decode(
            claimed["key_packages"][bob_dev.to_string()]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    let (_, claimed_again) = server
        .post(
            "/v1/keys/claim",
            Some(&alice_token),
            json!({ "device_ids": [bob_dev] }),
        )
        .await;
    assert!(
        claimed_again["key_packages"]
            .as_object()
            .unwrap()
            .is_empty(),
        "key packages are single-use"
    );

    // Alice creates the conversation and sends a welcome plus a message.
    let mut alice_conv = Conversation::create(&alice).unwrap();
    let change = alice_conv.add_members(&alice, &[&bob_kp]).unwrap();
    let welcome = Envelope {
        version: PROTOCOL_VERSION,
        conversation_id: alice_conv.id(),
        epoch: 0,
        content_type: ContentType::Welcome.into(),
        ciphertext: change.welcome,
        message_id: message_id(),
    };
    let hello = envelope::seal(&mut alice_conv, &alice, b"hello bob", message_id()).unwrap();
    let mut alice_ws = server.connect(&alice_token).await;
    assert!(
        send(&mut alice_ws, welcome.clone(), &[bob_dev])
            .await
            .accepted
    );
    assert!(
        send(&mut alice_ws, hello.clone(), &[bob_dev])
            .await
            .accepted
    );

    // Bob comes online: queued envelopes arrive in order and decrypt.
    let mut bob_ws = server.connect(&bob_token).await;
    let got_welcome = expect_delivery(&mut bob_ws).await;
    assert_eq!(got_welcome, welcome);
    let mut bob_conv = Conversation::join(&bob, &got_welcome.ciphertext).unwrap();
    let got_hello = expect_delivery(&mut bob_ws).await;
    assert_eq!(
        envelope::open(&mut bob_conv, &bob, &got_hello).unwrap(),
        Received::Application {
            sender: b"alice".to_vec(),
            data: b"hello bob".to_vec()
        }
    );

    // Live push while Bob is connected.
    let live = envelope::seal(&mut alice_conv, &alice, b"are you there?", message_id()).unwrap();
    assert!(send(&mut alice_ws, live, &[bob_dev]).await.accepted);
    let got_live = expect_delivery(&mut bob_ws).await;
    assert_eq!(
        envelope::open(&mut bob_conv, &bob, &got_live).unwrap(),
        Received::Application {
            sender: b"alice".to_vec(),
            data: b"are you there?".to_vec()
        }
    );

    // Unacked envelopes are redelivered on reconnect; acked ones are not.
    for env in [&got_welcome, &got_hello] {
        bob_ws
            .send_frame(client_frame::Body::Ack(Ack {
                message_id: env.message_id.clone(),
            }))
            .await;
    }
    // Frames are handled in order, so the pong means the acks are applied.
    bob_ws.request(client_frame::Body::Ping(Ping {})).await;
    drop(bob_ws);
    let mut bob_ws = server.connect(&bob_token).await;
    assert_eq!(
        expect_delivery(&mut bob_ws).await.message_id,
        got_live.message_id
    );
    bob_ws
        .send_frame(client_frame::Body::Ack(Ack {
            message_id: got_live.message_id.clone(),
        }))
        .await;
    bob_ws.request(client_frame::Body::Ping(Ping {})).await;
    drop(bob_ws);
    let mut bob_ws = server.connect(&bob_token).await;
    assert!(
        bob_ws
            .next_frame(Duration::from_millis(300))
            .await
            .is_none(),
        "queue should be empty"
    );
}

#[sqlx::test]
async fn one_commit_per_epoch(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (dev, token) = server.register("+15550004444").await;
    server.admit(b"group-1", &[dev]).await;
    let mut ws = server.connect(&token).await;
    let commit = |epoch: u64| Envelope {
        version: PROTOCOL_VERSION,
        conversation_id: b"group-1".to_vec(),
        epoch,
        content_type: ContentType::Handshake.into(),
        ciphertext: Uuid::new_v4().as_bytes().to_vec(),
        message_id: message_id(),
    };

    let first = send(&mut ws, commit(3), &[dev]).await;
    assert!(first.accepted && !first.epoch_conflict);
    let racing = send(&mut ws, commit(3), &[dev]).await;
    assert!(
        !racing.accepted && racing.epoch_conflict,
        "second commit on epoch 3 must lose"
    );
    let winner = commit(4);
    let next = send(&mut ws, winner.clone(), &[dev]).await;
    assert!(next.accepted, "commit on the new epoch is accepted");

    // A client that lost the reply can ask which commit the group applied.
    let group = STANDARD.encode(b"group-1");
    let (status, epoch) = server
        .post(
            "/v1/groups/epoch",
            Some(&token),
            json!({ "group_id": group }),
        )
        .await;
    assert_eq!(status, 200, "{epoch}");
    assert_eq!(epoch["epoch"], 5);
    let expected = STANDARD.encode(Sha256::digest(&winner.ciphertext));
    assert_eq!(epoch["last_commit_hash"], expected.as_str());

    let unknown = STANDARD.encode(b"no-such-group");
    let (status, _) = server
        .post(
            "/v1/groups/epoch",
            Some(&token),
            json!({ "group_id": unknown }),
        )
        .await;
    assert_eq!(status, 404);
    let (status, _) = server
        .post("/v1/groups/epoch", None, json!({ "group_id": group }))
        .await;
    assert_eq!(status, 401);
}

#[sqlx::test]
async fn websocket_requires_authentication(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (ws, _) = tokio_tungstenite::connect_async(&server.ws_url)
        .await
        .unwrap();
    let mut client = Client::new(ws);
    let reply = client
        .request(client_frame::Body::Send(SendEnvelope {
            envelope: None,
            recipient_devices: vec![],
            ..Default::default()
        }))
        .await;
    assert!(matches!(reply.body, Some(server_frame::Body::Error(e)) if e.code == 401));
    let reply = client
        .request(client_frame::Body::Authenticate(
            chat_proto::v1::Authenticate {
                token: "nope".into(),
            },
        ))
        .await;
    assert!(matches!(reply.body, Some(server_frame::Body::Error(e)) if e.code == 401));
}

#[sqlx::test]
async fn commit_survives_a_lost_reply(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (dev, token) = server.register("+15550005555").await;
    server.admit(b"group-2", &[dev]).await;
    let mut ws = server.connect(&token).await;
    let commit = Envelope {
        version: PROTOCOL_VERSION,
        conversation_id: b"group-2".to_vec(),
        epoch: 1,
        content_type: ContentType::Handshake.into(),
        ciphertext: b"commit-bytes".to_vec(),
        message_id: message_id(),
    };
    // Send, then drop the connection without reading the reply.
    ws.send_frame(client_frame::Body::Send(SendEnvelope {
        envelope: Some(commit.clone()),
        recipient_devices: vec![dev.as_bytes().to_vec()],
        ..Default::default()
    }))
    .await;
    drop(ws);

    // After reconnecting, the client asks which commit the group applied.
    let group = STANDARD.encode(b"group-2");
    let expected = STANDARD.encode(Sha256::digest(&commit.ciphertext));
    for _ in 0..50 {
        let (status, epoch) = server
            .post(
                "/v1/groups/epoch",
                Some(&token),
                json!({ "group_id": group }),
            )
            .await;
        if status == 200 {
            assert_eq!(epoch["epoch"], 2);
            assert_eq!(epoch["last_commit_hash"], expected.as_str());
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("commit was not recorded");
}

/// Concurrent sends to one device must all reach its open connection, even
/// when they commit out of queue order (the connection reads its queue
/// with a cursor).
#[sqlx::test]
async fn concurrent_sends_all_reach_a_connected_device(pool: PgPool) {
    const SENDERS: usize = 20;
    const EACH: usize = 20;
    let server = TestServer::start(pool).await;
    let (bob, bob_token) = server.register("+15550007000").await;
    let mut senders = Vec::new();
    for i in 0..SENDERS {
        let (dev, token) = server.register(&format!("+1555000{:04}", 7001 + i)).await;
        senders.push((dev, token));
    }
    let mut members: Vec<Uuid> = senders.iter().map(|(d, _)| *d).collect();
    members.push(bob);
    server.admit(b"busy", &members).await;
    let mut b = server.connect(&bob_token).await;

    let mut tasks = Vec::new();
    for (_, token) in &senders {
        let mut client = server.connect(token).await;
        tasks.push(tokio::spawn(async move {
            for _ in 0..EACH {
                let env = Envelope {
                    version: PROTOCOL_VERSION,
                    conversation_id: b"busy".to_vec(),
                    epoch: 0,
                    content_type: ContentType::Application.into(),
                    ciphertext: b"x".to_vec(),
                    message_id: message_id(),
                };
                assert!(send(&mut client, env, &[bob]).await.accepted);
            }
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    let mut received = std::collections::HashSet::new();
    while received.len() < SENDERS * EACH {
        let env = expect_delivery(&mut b).await;
        received.insert(env.message_id);
    }
}

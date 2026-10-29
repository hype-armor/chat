//! Send authorisation (ADR-0017).
mod support;

use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope, SendEnvelope, server_frame},
};
use serde_json::json;
use sqlx::PgPool;
use support::{Client, TestServer};
use uuid::Uuid;

fn envelope(conversation: &[u8], content_type: ContentType, epoch: u64) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION,
        conversation_id: conversation.to_vec(),
        epoch,
        content_type: content_type.into(),
        ciphertext: Uuid::new_v4().as_bytes().to_vec(),
        message_id: Uuid::new_v4().as_bytes().to_vec(),
    }
}

fn ids(devices: &[Uuid]) -> Vec<Vec<u8>> {
    devices.iter().map(|d| d.as_bytes().to_vec()).collect()
}

/// Sends and returns `Ok(accepted)` or `Err(http-style error code)`.
async fn send(client: &mut Client, send: SendEnvelope) -> Result<bool, u32> {
    let reply = client
        .request(chat_proto::v1::client_frame::Body::Send(send))
        .await;
    match reply.body {
        Some(server_frame::Body::SendResult(r)) => Ok(r.accepted),
        Some(server_frame::Body::Error(e)) => Err(e.code),
        other => panic!("unexpected reply {other:?}"),
    }
}

fn plain(env: Envelope, to: &[Uuid]) -> SendEnvelope {
    SendEnvelope {
        envelope: Some(env),
        recipient_devices: ids(to),
        ..Default::default()
    }
}

/// Registers a device and uploads one key package for others to claim.
async fn user(server: &TestServer, phone: &str) -> (Uuid, String) {
    let (dev, token) = server.register(phone).await;
    let kp = STANDARD.encode(Uuid::new_v4().as_bytes());
    let (status, _) = server
        .post("/v1/keys", Some(&token), json!({ "key_packages": [kp] }))
        .await;
    assert_eq!(status, 204);
    (dev, token)
}

async fn claim(server: &TestServer, token: &str, devices: &[Uuid]) {
    let (status, body) = server
        .post(
            "/v1/keys/claim",
            Some(token),
            json!({ "device_ids": devices }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
}

#[sqlx::test]
async fn only_members_send_and_receive(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (alice, alice_token) = user(&server, "+15550007001").await;
    let (bob, _) = user(&server, "+15550007002").await;
    let (mallory, mallory_token) = user(&server, "+15550007003").await;
    server.admit(b"conv", &[alice, bob]).await;
    let mut alice_ws = server.connect(&alice_token).await;
    let mut mallory_ws = server.connect(&mallory_token).await;

    let msg = || envelope(b"conv", ContentType::Application, 0);
    assert_eq!(send(&mut alice_ws, plain(msg(), &[bob])).await, Ok(true));
    // A stranger can't send into the conversation...
    assert_eq!(send(&mut mallory_ws, plain(msg(), &[bob])).await, Err(403));
    // ...nor can a member send to someone outside it.
    assert_eq!(
        send(&mut alice_ws, plain(msg(), &[mallory])).await,
        Err(403)
    );
    // Commits and proposals follow the same rule.
    assert_eq!(
        send(
            &mut mallory_ws,
            plain(envelope(b"conv", ContentType::Handshake, 0), &[bob])
        )
        .await,
        Err(403)
    );
    let _ = mallory;
}

#[sqlx::test]
async fn welcomes_need_a_claimed_key_package(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (alice, alice_token) = user(&server, "+15550007011").await;
    let (bob, bob_token) = user(&server, "+15550007012").await;
    let (_, mallory_token) = user(&server, "+15550007013").await;
    let mut alice_ws = server.connect(&alice_token).await;

    let welcome = || envelope(b"new-conv", ContentType::Welcome, 0);
    assert_eq!(
        send(&mut alice_ws, plain(welcome(), &[bob])).await,
        Err(403),
        "no claim yet"
    );
    claim(&server, &alice_token, &[bob]).await;
    assert_eq!(
        send(&mut alice_ws, plain(welcome(), &[bob])).await,
        Ok(true)
    );

    // Both are now members: they can talk in that conversation.
    let mut bob_ws = server.connect(&bob_token).await;
    let reply = envelope(b"new-conv", ContentType::Application, 0);
    assert_eq!(send(&mut bob_ws, plain(reply, &[alice])).await, Ok(true));

    // An outsider can't send welcomes into an existing conversation, even
    // after claiming keys.
    let mut mallory_ws = server.connect(&mallory_token).await;
    claim(&server, &mallory_token, &[bob]).await;
    assert_eq!(
        send(&mut mallory_ws, plain(welcome(), &[bob])).await,
        Err(403)
    );
}

#[sqlx::test]
async fn commit_and_welcome_are_accepted_together(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (alice, alice_token) = user(&server, "+15550007021").await;
    let (bob, bob_token) = user(&server, "+15550007022").await;
    let (carol, carol_token) = user(&server, "+15550007023").await;
    server.admit(b"group", &[alice, bob]).await;
    let mut alice_ws = server.connect(&alice_token).await;

    let commit = |epoch| envelope(b"group", ContentType::Handshake, epoch);
    let with_welcome = |commit: Envelope| SendEnvelope {
        envelope: Some(commit),
        recipient_devices: ids(&[bob]),
        welcome: Some(envelope(b"group", ContentType::Welcome, 0)),
        welcome_recipients: ids(&[carol]),
        silent: false,
    };
    // Without a claim the whole send fails, and the epoch doesn't advance.
    assert_eq!(send(&mut alice_ws, with_welcome(commit(1))).await, Err(403));
    claim(&server, &alice_token, &[carol]).await;
    assert_eq!(send(&mut alice_ws, with_welcome(commit(1))).await, Ok(true));

    // Carol is a member as soon as the commit is accepted: Bob can reach her
    // immediately, and her welcome is already queued ahead of his message.
    let mut bob_ws = server.connect(&bob_token).await;
    let hello = envelope(b"group", ContentType::Application, 2);
    assert_eq!(
        send(&mut bob_ws, plain(hello.clone(), &[carol])).await,
        Ok(true)
    );
    let mut carol_ws = server.connect(&carol_token).await;
    let first = carol_ws.next_frame(Duration::from_secs(5)).await.unwrap();
    assert!(
        matches!(first.body, Some(server_frame::Body::Deliver(ref e)) if e.content_type == i32::from(ContentType::Welcome))
    );
    let second = carol_ws.next_frame(Duration::from_secs(5)).await.unwrap();
    assert!(
        matches!(second.body, Some(server_frame::Body::Deliver(e)) if e.message_id == hello.message_id)
    );

    // A welcome only rides along with a commit.
    let bad = SendEnvelope {
        envelope: Some(envelope(b"group", ContentType::Application, 2)),
        recipient_devices: ids(&[bob]),
        welcome: Some(envelope(b"group", ContentType::Welcome, 0)),
        welcome_recipients: ids(&[carol]),
        silent: false,
    };
    assert_eq!(send(&mut alice_ws, bad).await, Err(400));
}

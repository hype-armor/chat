//! Conversation membership follows the commits that change it (M11): a
//! device that a commit removes loses send and call access at once.
mod support;

use base64::{Engine, engine::general_purpose::STANDARD};
use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope, SendEnvelope, client_frame, server_frame},
};
use chat_server::{calls::LiveKitConfig, limits::Limits};
use serde_json::{Value, json};
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
    let reply = client.request(client_frame::Body::Send(send)).await;
    match reply.body {
        Some(server_frame::Body::SendResult(r)) => Ok(r.accepted),
        Some(server_frame::Body::Error(e)) => Err(e.code),
        other => panic!("unexpected reply {other:?}"),
    }
}

/// A plain message to `to`, with no members list.
fn message(conversation: &[u8], epoch: u64, to: &[Uuid]) -> SendEnvelope {
    SendEnvelope {
        envelope: Some(envelope(conversation, ContentType::Application, epoch)),
        recipient_devices: ids(to),
        ..Default::default()
    }
}

fn livekit() -> LiveKitConfig {
    LiveKitConfig {
        url: Some("wss://rtc.example.com".into()),
        api_url: None,
        api_key: "key".into(),
        api_secret: "a-secret-of-at-least-32-characters!".into(),
    }
}

fn join_request(conversation: &[u8]) -> Value {
    json!({
        "conversation_id": STANDARD.encode(conversation),
        "call_id": STANDARD.encode([7u8; 16]),
    })
}

#[sqlx::test]
async fn a_commit_that_removes_a_member_ends_its_send_and_call_access(pool: PgPool) {
    let server = TestServer::start_with_livekit(pool, None, Limits::default(), livekit()).await;
    let (alice, alice_token) = server.register("u5550006001.10").await;
    let (bob, bob_token) = server.register("u5550006002.10").await;
    server.admit(b"group", &[alice, bob]).await;
    let call = join_request(b"group");

    // Both devices are members, so both get a room token at first.
    let (status, body) = server
        .post("/v1/calls/join", Some(&bob_token), call.clone())
        .await;
    assert_eq!(status, 200, "{body}");

    // Alice commits a removal: after this commit she is the only member.
    let mut alice_ws = server.connect(&alice_token).await;
    let commit = SendEnvelope {
        envelope: Some(envelope(b"group", ContentType::Handshake, 3)),
        recipient_devices: ids(&[bob]),
        members: ids(&[alice]),
        ..Default::default()
    };
    let commit_id = commit.envelope.as_ref().unwrap().message_id.clone();
    assert_eq!(send(&mut alice_ws, commit).await, Ok(true));

    // The removed device still needs the old-epoch commit to learn it is out.
    let mut bob_ws = server.connect(&bob_token).await;
    let delivery = bob_ws
        .next_frame(std::time::Duration::from_secs(5))
        .await
        .expect("removal commit");
    match delivery.body {
        Some(server_frame::Body::Deliver(d)) => {
            assert_eq!(d.message_id, commit_id);
        }
        other => panic!("expected removal commit, got {other:?}"),
    }

    // Bob has no room token now, and his sends are refused.
    let (status, body) = server
        .post("/v1/calls/join", Some(&bob_token), call.clone())
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(
        send(&mut bob_ws, message(b"group", 4, &[alice])).await,
        Err(403)
    );

    // Alice keeps her access.
    let (status, body) = server
        .post("/v1/calls/join", Some(&alice_token), call)
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        send(&mut alice_ws, message(b"group", 4, &[alice])).await,
        Ok(true)
    );
}

#[sqlx::test]
async fn a_members_list_the_sender_cannot_use_is_refused(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (alice, alice_token) = server.register("u5550006011.10").await;
    let (bob, bob_token) = server.register("u5550006012.10").await;
    server.admit(b"group", &[alice, bob]).await;
    let mut alice_ws = server.connect(&alice_token).await;
    let mut bob_ws = server.connect(&bob_token).await;

    // The sender must be a member after its own commit.
    let without_self = SendEnvelope {
        envelope: Some(envelope(b"group", ContentType::Handshake, 1)),
        recipient_devices: ids(&[alice]),
        members: ids(&[bob]),
        ..Default::default()
    };
    assert_eq!(send(&mut alice_ws, without_self).await, Err(400));

    // At most 500 devices.
    let too_many = SendEnvelope {
        envelope: Some(envelope(b"group", ContentType::Handshake, 1)),
        recipient_devices: ids(&[alice]),
        members: (0..501)
            .map(|_| Uuid::new_v4().as_bytes().to_vec())
            .collect(),
        ..Default::default()
    };
    assert_eq!(send(&mut alice_ws, too_many).await, Err(400));

    // A device the server no longer has is dropped, not refused: a committer's
    // local group still lists a device that a restore replaced.
    let unknown = SendEnvelope {
        envelope: Some(envelope(b"group", ContentType::Handshake, 2)),
        recipient_devices: ids(&[alice]),
        members: ids(&[alice, bob, Uuid::new_v4()]),
        ..Default::default()
    };
    assert_eq!(send(&mut alice_ws, unknown).await, Ok(true));

    // Neither refused request changed the membership: Bob still sends.
    assert_eq!(
        send(&mut bob_ws, message(b"group", 1, &[alice])).await,
        Ok(true)
    );

    // Only a commit changes membership; a list on a message is ignored.
    let on_a_message = SendEnvelope {
        envelope: Some(envelope(b"group", ContentType::Application, 1)),
        recipient_devices: ids(&[alice]),
        members: ids(&[alice]),
        ..Default::default()
    };
    assert_eq!(send(&mut alice_ws, on_a_message).await, Ok(true));
    assert_eq!(
        send(&mut bob_ws, message(b"group", 1, &[alice])).await,
        Ok(true)
    );
}

#[sqlx::test]
async fn a_commit_that_loses_its_epoch_changes_no_membership(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (alice, alice_token) = server.register("u5550006021.10").await;
    let (bob, bob_token) = server.register("u5550006022.10").await;
    server.admit(b"group", &[alice, bob]).await;
    let mut alice_ws = server.connect(&alice_token).await;
    let removal = |epoch: u64, members: &[Uuid]| SendEnvelope {
        envelope: Some(envelope(b"group", ContentType::Handshake, epoch)),
        recipient_devices: ids(&[alice]),
        members: ids(members),
        ..Default::default()
    };

    // The first commit for epoch 2 wins and leaves alice alone in the group.
    assert_eq!(send(&mut alice_ws, removal(2, &[alice])).await, Ok(true));
    // A second commit for the same epoch loses the race, and its member list
    // is not applied: bob stays out even though this one lists him again.
    assert_eq!(
        send(&mut alice_ws, removal(2, &[alice, bob])).await,
        Ok(false)
    );

    let mut bob_ws = server.connect(&bob_token).await;
    assert_eq!(
        send(&mut bob_ws, message(b"group", 3, &[alice])).await,
        Err(403),
        "the losing commit did not put bob back"
    );
    assert_eq!(
        send(&mut alice_ws, message(b"group", 3, &[bob])).await,
        Err(403),
        "bob is no longer a member to send to"
    );
}

//! Queue quotas (audit H3): one sender must not be able to fill a recipient's
//! delivery queue, and a device's daily envelope budget stops a flood.
mod support;

use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope, SendEnvelope, client_frame, server_frame},
};
use chat_server::limits::Limits;
use sqlx::PgPool;
use support::{Client, TestServer};
use uuid::Uuid;

fn envelope(ciphertext: Vec<u8>, message_id: Vec<u8>) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION,
        conversation_id: b"queue".to_vec(),
        epoch: 0,
        content_type: ContentType::Application.into(),
        ciphertext,
        message_id,
    }
}

/// Sends one envelope; `Ok(accepted)`, or the error code.
async fn send(client: &mut Client, env: Envelope, to: &[Uuid]) -> Result<bool, u32> {
    let send = SendEnvelope {
        envelope: Some(env),
        recipient_devices: to.iter().map(|d| d.as_bytes().to_vec()).collect(),
        ..Default::default()
    };
    match client.request(client_frame::Body::Send(send)).await.body {
        Some(server_frame::Body::SendResult(r)) => Ok(r.accepted),
        Some(server_frame::Body::Error(e)) => Err(e.code),
        other => panic!("{other:?}"),
    }
}

#[sqlx::test]
async fn the_queue_keeps_the_newest_envelopes(pool: PgPool) {
    let server = TestServer::start_with_limits(
        pool,
        Limits {
            queue_rows_per_device: 3,
            ..Limits::default()
        },
    )
    .await;
    let (alice, alice_token) = server.register("u5550010001.10").await;
    let (bob, _) = server.register("u5550010002.10").await;
    server.admit(b"queue", &[alice, bob]).await;
    let mut ws = server.connect(&alice_token).await;

    let mut sent = Vec::new();
    for i in 0..5u8 {
        let id = Uuid::new_v4().as_bytes().to_vec();
        sent.push(id.clone());
        assert_eq!(
            send(&mut ws, envelope(vec![i; 64], id), &[bob]).await,
            Ok(true)
        );
    }

    let rows: Vec<(Vec<u8>,)> = sqlx::query_as(
        "SELECT message_id FROM queued_envelopes
         WHERE recipient_device_id = $1 ORDER BY queue_id",
    )
    .bind(bob)
    .fetch_all(server.state.db.as_ref().unwrap())
    .await
    .unwrap();
    let kept: Vec<Vec<u8>> = rows.into_iter().map(|(id,)| id).collect();
    assert_eq!(
        kept,
        sent[2..].to_vec(),
        "the three newest envelopes stay, the oldest two go"
    );
}

#[sqlx::test]
async fn a_devices_daily_envelope_budget_stops_a_flood(pool: PgPool) {
    let server = TestServer::start_with_limits(
        pool,
        Limits {
            send_mb_per_day: 1,
            sends_per_minute: 100,
            ..Limits::default()
        },
    )
    .await;
    let (alice, alice_token) = server.register("u5550010011.10").await;
    let (bob, _) = server.register("u5550010012.10").await;
    server.admit(b"queue", &[alice, bob]).await;
    let mut ws = server.connect(&alice_token).await;

    let (mut accepted, mut refused) = (0, 0);
    for _ in 0..9 {
        match send(
            &mut ws,
            envelope(vec![7; 128 * 1024], Uuid::new_v4().as_bytes().to_vec()),
            &[bob],
        )
        .await
        {
            Ok(true) => accepted += 1,
            Err(429) => refused += 1,
            other => panic!("unexpected send result: {other:?}"),
        }
    }
    // 1 MiB of allowance fits about eight 128 KiB envelopes, not nine.
    assert!(
        accepted >= 7,
        "a MiB still sends several envelopes: {accepted}"
    );
    assert!(refused > 0, "the ninth envelope exceeds the daily budget");
    assert_eq!(accepted + refused, 9);
}

#[sqlx::test]
async fn a_zero_budget_refuses_every_envelope(pool: PgPool) {
    let server = TestServer::start_with_limits(
        pool,
        Limits {
            send_mb_per_day: 0,
            ..Limits::default()
        },
    )
    .await;
    let (alice, alice_token) = server.register("u5550010021.10").await;
    let (bob, _) = server.register("u5550010022.10").await;
    server.admit(b"queue", &[alice, bob]).await;
    let mut ws = server.connect(&alice_token).await;
    let result = send(
        &mut ws,
        envelope(b"x".to_vec(), Uuid::new_v4().as_bytes().to_vec()),
        &[bob],
    )
    .await;
    assert_eq!(result, Err(429));
}

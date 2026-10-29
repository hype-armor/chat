//! Server metrics (doc 03 §observability).
mod support;

use std::time::Duration;

use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope, SendEnvelope, client_frame, server_frame},
};
use sqlx::PgPool;
use support::TestServer;
use uuid::Uuid;

/// The value of an un-labelled sample, e.g. `chat_delivery_seconds_count`.
fn sample(text: &str, name: &str) -> f64 {
    text.lines()
        .find_map(|l| l.strip_prefix(name)?.strip_prefix(' ')?.parse().ok())
        .unwrap_or_else(|| panic!("{name} missing from:\n{text}"))
}

#[sqlx::test]
async fn sends_deliveries_and_connections_are_measured(pool: PgPool) {
    let server = TestServer::start(pool).await;
    let (alice, alice_token) = server.register("+15550009001").await;
    let (bob, bob_token) = server.register("+15550009002").await;
    server.admit(b"m", &[alice, bob]).await;
    let mut a = server.connect(&alice_token).await;
    let mut b = server.connect(&bob_token).await;

    let send = |conversation: &[u8], to: Uuid| {
        client_frame::Body::Send(SendEnvelope {
            envelope: Some(Envelope {
                version: PROTOCOL_VERSION,
                conversation_id: conversation.to_vec(),
                epoch: 0,
                content_type: ContentType::Application.into(),
                ciphertext: b"x".to_vec(),
                message_id: Uuid::new_v4().as_bytes().to_vec(),
            }),
            recipient_devices: vec![to.as_bytes().to_vec()],
            ..Default::default()
        })
    };
    a.request(send(b"m", bob)).await;
    let frame = b
        .next_frame(Duration::from_secs(5))
        .await
        .expect("delivery");
    assert!(matches!(frame.body, Some(server_frame::Body::Deliver(_))));
    // Not a member of that conversation: refused.
    a.request(send(b"elsewhere", bob)).await;

    // A delivery is recorded after the socket write returns, which can be
    // just after the client has the frame.
    assert!(settles(&server, "chat_delivery_seconds_count", 1.0).await);
    let text = server.state.metrics.render();
    assert_eq!(sample(&text, "chat_websocket_connections"), 2.0);
    assert_eq!(sample(&text, "chat_send_seconds_count"), 2.0);
    assert!(sample(&text, "chat_delivery_seconds_sum") < 5.0);
    assert!(
        text.contains(r#"chat_send_errors_total{code="403"} 1"#),
        "{text}"
    );

    drop(b);
    // The server notices the closed socket asynchronously.
    assert!(
        settles(&server, "chat_websocket_connections", 1.0).await,
        "connection gauge did not drop"
    );
}

/// Whether a sample reaches `value` within a second.
async fn settles(server: &TestServer, name: &str, value: f64) -> bool {
    for _ in 0..50 {
        if sample(&server.state.metrics.render(), name) == value {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

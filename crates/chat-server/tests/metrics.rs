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

    let send = |to: Uuid| {
        client_frame::Body::Send(SendEnvelope {
            envelope: Some(Envelope {
                version: PROTOCOL_VERSION,
                conversation_id: b"m".to_vec(),
                epoch: 0,
                content_type: ContentType::Application.into(),
                ciphertext: b"x".to_vec(),
                message_id: Uuid::new_v4().as_bytes().to_vec(),
            }),
            recipient_devices: vec![to.as_bytes().to_vec()],
            ..Default::default()
        })
    };
    a.request(send(bob)).await;
    let frame = b
        .next_frame(Duration::from_secs(5))
        .await
        .expect("delivery");
    assert!(matches!(frame.body, Some(server_frame::Body::Deliver(_))));
    // An unknown recipient device is refused.
    a.request(send(Uuid::new_v4())).await;

    let text = server.state.metrics.render();
    assert_eq!(sample(&text, "chat_websocket_connections"), 2.0);
    assert_eq!(sample(&text, "chat_send_seconds_count"), 2.0);
    assert_eq!(sample(&text, "chat_delivery_seconds_count"), 1.0);
    assert!(sample(&text, "chat_delivery_seconds_sum") < 5.0);
    assert!(
        text.contains(r#"chat_send_errors_total{code="400"} 1"#),
        "{text}"
    );

    drop(b);
    // The server notices the closed socket asynchronously.
    for _ in 0..50 {
        if sample(&server.state.metrics.render(), "chat_websocket_connections") == 1.0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("connection gauge did not drop");
}

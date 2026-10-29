//! Abuse limits (FR-SAF-2).
mod support;

use base64::{Engine, engine::general_purpose::STANDARD};
use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ContentType, Envelope, SendEnvelope, client_frame, server_frame},
};
use chat_server::limits::Limits;
use serde_json::json;
use sqlx::PgPool;
use support::TestServer;
use uuid::Uuid;

fn tight() -> Limits {
    Limits {
        lookups_per_hour: 2,
        claims_per_hour: 2,
        welcomes_per_day: 1,
        sends_per_minute: 2,
        registrations_per_ip_per_hour: 2,
        registrations_per_day: 100,
        invites_per_day: 2,
        links_per_ip_per_hour: 2,
        reports_per_day: 2,
        device_lists_per_hour: 2,
        trust_proxy_headers: true,
    }
}

#[sqlx::test]
async fn lookups_and_claims_are_limited(pool: PgPool) {
    let server = TestServer::start_with_limits(pool, tight()).await;
    let (_, token) = server.register("u5550008001.10").await;
    let target = json!({ "username": "u5550008001.10" });
    for _ in 0..2 {
        assert_eq!(
            server
                .post("/v1/lookup", Some(&token), target.clone())
                .await
                .0,
            200
        );
    }
    assert_eq!(server.post("/v1/lookup", Some(&token), target).await.0, 429);

    // Claims count devices, not requests.
    let devices: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
    let (status, _) = server
        .post(
            "/v1/keys/claim",
            Some(&token),
            json!({ "device_ids": devices }),
        )
        .await;
    assert_eq!(status, 429, "3 devices exceed a limit of 2");
    let (status, _) = server
        .post(
            "/v1/keys/claim",
            Some(&token),
            json!({ "device_ids": &devices[..2] }),
        )
        .await;
    assert_eq!(status, 200);
    let (status, _) = server
        .post(
            "/v1/keys/claim",
            Some(&token),
            json!({ "device_ids": &devices[..1] }),
        )
        .await;
    assert_eq!(status, 429);
}

#[sqlx::test]
async fn sign_ups_are_limited_per_ip(pool: PgPool) {
    let server = TestServer::start_with_limits(pool, tight()).await;
    let sign_up = |username: &str, ip: &str| {
        let (username, ip) = (username.to_owned(), ip.to_owned());
        let server = &server;
        async move {
            let body = json!({ "username": username, "identity_key": STANDARD.encode(b"k") });
            server
                .post_with_headers("/v1/register", None, body, &[("x-forwarded-for", &ip)])
                .await
                .0
        }
    };
    // The third sign-up from one address in an hour is refused.
    assert_eq!(sign_up("ann.01", "203.0.113.7").await, 200);
    assert_eq!(sign_up("ben.01", "203.0.113.7").await, 200);
    assert_eq!(sign_up("cat.01", "203.0.113.7").await, 429);
    // Forged entries before the ingress's own do not help.
    assert_eq!(sign_up("dee.01", "192.0.2.1, 203.0.113.7").await, 429);
    assert_eq!(sign_up("eve.01", "198.51.100.1").await, 200);
}

#[sqlx::test]
async fn sends_and_first_contacts_are_limited(pool: PgPool) {
    let server = TestServer::start_with_limits(pool, tight()).await;
    let (alice, alice_token) = server.register("u5550008011.10").await;
    let mut contacts = Vec::new();
    for phone in ["u5550008012.10", "u5550008013.10"] {
        let (dev, token) = server.register(phone).await;
        let kp = STANDARD.encode(Uuid::new_v4().as_bytes());
        server
            .post("/v1/keys", Some(&token), json!({ "key_packages": [kp] }))
            .await;
        contacts.push(dev);
    }
    server
        .post(
            "/v1/keys/claim",
            Some(&alice_token),
            json!({ "device_ids": contacts }),
        )
        .await;
    let mut ws = server.connect(&alice_token).await;

    let mut send = async |content_type: ContentType, to: &[Uuid]| {
        let envelope = Envelope {
            version: PROTOCOL_VERSION,
            conversation_id: b"c".to_vec(),
            epoch: 0,
            content_type: content_type.into(),
            ciphertext: b"x".to_vec(),
            message_id: Uuid::new_v4().as_bytes().to_vec(),
        };
        let send = SendEnvelope {
            envelope: Some(envelope),
            recipient_devices: to.iter().map(|d| d.as_bytes().to_vec()).collect(),
            ..Default::default()
        };
        match ws.request(client_frame::Body::Send(send)).await.body {
            Some(server_frame::Body::SendResult(r)) => Ok(r.accepted),
            Some(server_frame::Body::Error(e)) => Err(e.code),
            other => panic!("{other:?}"),
        }
    };
    // One first contact per day: welcoming two devices at once is refused.
    assert_eq!(send(ContentType::Welcome, &contacts).await, Err(429));
    // Two sends per minute (the refused one above counted too).
    assert_eq!(send(ContentType::Welcome, &contacts[..1]).await, Ok(true));
    assert_eq!(
        send(ContentType::Application, &contacts[..1]).await,
        Err(429)
    );
    let _ = alice;
}

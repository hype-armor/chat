use axum::{body::Body, http::Request};
use chat_proto::v1::{ClientFrame, Ping, ServerFrame, client_frame, server_frame};
use chat_server::{AppState, router};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use prost::Message as _;
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;

#[tokio::test]
async fn health_and_readiness() {
    for path in ["/healthz", "/readyz"] {
        let res = router(AppState::default())
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(res.status().is_success(), "{path}");
        let _ = res.into_body().collect().await.unwrap();
    }
}

#[tokio::test]
async fn websocket_ping_pong_and_malformed_frame() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router(AppState::default())).await });

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/ws"))
        .await
        .unwrap();

    let ping = ClientFrame {
        request_id: 7,
        body: Some(client_frame::Body::Ping(Ping {})),
    };
    ws.send(Message::Binary(ping.encode_to_vec().into()))
        .await
        .unwrap();
    let reply = ServerFrame::decode(ws.next().await.unwrap().unwrap().into_data()).unwrap();
    assert_eq!(reply.request_id, 7);
    assert!(matches!(reply.body, Some(server_frame::Body::Pong(_))));

    ws.send(Message::Binary(vec![0xff, 0xff, 0xff].into()))
        .await
        .unwrap();
    let reply = ServerFrame::decode(ws.next().await.unwrap().unwrap().into_data()).unwrap();
    assert!(matches!(reply.body, Some(server_frame::Body::Error(e)) if e.code == 400));
}

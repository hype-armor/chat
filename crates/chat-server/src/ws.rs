//! Client WebSocket: binary Protobuf `ClientFrame`s in, `ServerFrame`s out.

use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::Response,
};
use chat_proto::{
    PROTOCOL_VERSION,
    v1::{ClientFrame, Error, Pong, ServerFrame, client_frame, server_frame},
};
use prost::Message as _;

use crate::AppState;

/// Upper bound on one frame; attachments go to blob storage, not the socket.
const MAX_FRAME_BYTES: usize = 256 * 1024;

pub async fn upgrade(ws: WebSocketUpgrade, State(_state): State<AppState>) -> Response {
    ws.max_message_size(MAX_FRAME_BYTES).on_upgrade(handle)
}

async fn handle(mut socket: WebSocket) {
    while let Some(Ok(msg)) = socket.recv().await {
        let reply = match msg {
            Message::Binary(bytes) => respond(&bytes),
            Message::Close(_) => break,
            _ => continue,
        };
        if socket
            .send(Message::Binary(reply.encode_to_vec().into()))
            .await
            .is_err()
        {
            break;
        }
    }
}

fn respond(bytes: &[u8]) -> ServerFrame {
    let Ok(frame) = ClientFrame::decode(bytes) else {
        return error(0, 400, "malformed frame");
    };
    let request_id = frame.request_id;
    match frame.body {
        Some(client_frame::Body::Ping(_)) => ServerFrame {
            request_id,
            body: Some(server_frame::Body::Pong(Pong {})),
        },
        Some(client_frame::Body::Send(send)) => match send.envelope {
            Some(env) if env.version != PROTOCOL_VERSION => {
                error(request_id, 400, "unsupported protocol version")
            }
            Some(_) => error(request_id, 501, "delivery not implemented yet"),
            None => error(request_id, 400, "missing envelope"),
        },
        Some(client_frame::Body::Ack(_)) => error(request_id, 501, "delivery not implemented yet"),
        None => error(request_id, 400, "empty frame"),
    }
}

fn error(request_id: u64, code: u32, message: &str) -> ServerFrame {
    ServerFrame {
        request_id,
        body: Some(server_frame::Body::Error(Error {
            code,
            message: message.to_owned(),
        })),
    }
}

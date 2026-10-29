//! Client WebSocket: binary Protobuf `ClientFrame`s in, `ServerFrame`s out.
//!
//! Flow: the client authenticates with its device token, the server
//! flushes the device's queue, then pushes new envelopes as they arrive.
//! Envelopes stay queued until the client acks them, so anything unacked
//! is redelivered on the next connection.

use std::time::Duration;

use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::Response,
};
use chat_proto::v1::{
    AuthResult, ClientFrame, Error, Pong, SendEnvelope, SendResult, ServerFrame, client_frame,
    server_frame,
};
use prost::Message as _;
use sqlx::PgPool;
use tokio::{sync::mpsc, time};
use uuid::Uuid;

use crate::{
    AppState,
    auth::device_for_token,
    delivery::{self, SendOutcome},
    error::ApiError,
    hub::Registration,
};

/// Upper bound on one frame; attachments go to blob storage, not the socket.
const MAX_FRAME_BYTES: usize = 256 * 1024;
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// Keeps proxies (Traefik idle timeout) from closing quiet connections.
const PING_INTERVAL: Duration = Duration::from_secs(30);

pub async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_message_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| async move {
            if let Err(e) = Session::new(socket, state).run().await {
                tracing::debug!(error = %e, "websocket session ended");
            }
        })
}

struct Authed {
    device: Uuid,
    _registration: Registration,
    wake: mpsc::Receiver<()>,
    /// Highest queue_id sent on this connection.
    cursor: i64,
}

struct Session {
    socket: WebSocket,
    state: AppState,
    authed: Option<Authed>,
}

type SessionResult = Result<(), axum::Error>;

impl Session {
    fn new(socket: WebSocket, state: AppState) -> Self {
        Self {
            socket,
            state,
            authed: None,
        }
    }

    async fn run(mut self) -> SessionResult {
        let auth_deadline = time::sleep(AUTH_TIMEOUT);
        tokio::pin!(auth_deadline);
        let mut ping = time::interval(PING_INTERVAL);
        ping.tick().await;

        loop {
            tokio::select! {
                msg = self.socket.recv() => match msg {
                    Some(Ok(Message::Binary(bytes))) => {
                        let was_authed = self.authed.is_some();
                        if let Some(reply) = self.handle_frame(&bytes).await {
                            self.send(reply).await?;
                        }
                        // Just authenticated: deliver the backlog. Later
                        // envelopes arrive through hub wake-ups.
                        if !was_authed && self.authed.is_some() {
                            self.flush().await?;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e),
                },
                Some(()) = recv_wake(&mut self.authed) => self.flush().await?,
                () = &mut auth_deadline, if self.authed.is_none() => {
                    self.send(error(0, 401, "authentication timeout")).await?;
                    return Ok(());
                }
                _ = ping.tick() => self.socket.send(Message::Ping(Default::default())).await?,
            }
        }
    }

    /// Returns the reply frame, if the request has one.
    async fn handle_frame(&mut self, bytes: &[u8]) -> Option<ServerFrame> {
        let Ok(frame) = ClientFrame::decode(bytes) else {
            return Some(error(0, 400, "malformed frame"));
        };
        let id = frame.request_id;
        let Some(body) = frame.body else {
            return Some(error(id, 400, "empty frame"));
        };
        if let client_frame::Body::Ping(_) = body {
            return Some(reply(id, server_frame::Body::Pong(Pong {})));
        }
        let Some(db) = self.state.db.clone() else {
            return Some(api_error(id, &ApiError::Unavailable));
        };
        let result = match (body, &self.authed) {
            (client_frame::Body::Authenticate(auth), None) => {
                self.authenticate(&db, &auth.token).await
            }
            (client_frame::Body::Authenticate(_), Some(_)) => {
                Err(ApiError::BadRequest("already authenticated"))
            }
            (_, None) => Err(ApiError::Unauthorized("authenticate first")),
            (client_frame::Body::Send(send), Some(a)) => {
                send_envelope(&self.state, &db, a.device, send).await
            }
            (client_frame::Body::Ack(ack), Some(a)) => {
                delivery::ack(&db, a.device, &ack.message_id)
                    .await
                    .map(|()| None)
            }
            (client_frame::Body::Ping(_), _) => unreachable!("handled above"),
        };
        match result {
            Ok(Some(body)) => Some(reply(id, body)),
            // Acks are fire-and-forget.
            Ok(None) => None,
            Err(e) => Some(api_error(id, &e)),
        }
    }

    async fn authenticate(
        &mut self,
        db: &PgPool,
        token: &str,
    ) -> Result<Option<server_frame::Body>, ApiError> {
        let device = device_for_token(db, token)
            .await?
            .ok_or(ApiError::Unauthorized("invalid token"))?;
        let (registration, wake) = self.state.hub.register(device);
        self.authed = Some(Authed {
            device,
            _registration: registration,
            wake,
            cursor: 0,
        });
        Ok(Some(server_frame::Body::AuthResult(AuthResult {
            device_id: device.as_bytes().to_vec(),
        })))
    }

    /// Sends every queued envelope this connection hasn't sent yet.
    async fn flush(&mut self) -> SessionResult {
        let (Some(db), Some(authed)) = (self.state.db.clone(), self.authed.as_mut()) else {
            return Ok(());
        };
        loop {
            let batch = match delivery::pending(&db, authed.device, authed.cursor).await {
                Ok(batch) => batch,
                Err(e) => {
                    tracing::error!(error = ?e, "reading queue failed");
                    return Ok(());
                }
            };
            let full = batch.len() as i64 == delivery::BATCH;
            for (queue_id, envelope) in batch {
                authed.cursor = queue_id;
                let frame = reply(0, server_frame::Body::Deliver(envelope));
                self.socket
                    .send(Message::Binary(frame.encode_to_vec().into()))
                    .await?;
            }
            if !full {
                return Ok(());
            }
        }
    }

    async fn send(&mut self, frame: ServerFrame) -> SessionResult {
        self.socket
            .send(Message::Binary(frame.encode_to_vec().into()))
            .await
    }
}

/// Free function rather than a method: `&Session` isn't `Send` (the socket
/// isn't `Sync`), so it can't be held across awaits.
async fn send_envelope(
    state: &AppState,
    db: &PgPool,
    sender: Uuid,
    send: SendEnvelope,
) -> Result<Option<server_frame::Body>, ApiError> {
    let envelope = send
        .envelope
        .ok_or(ApiError::BadRequest("missing envelope"))?;
    // A commit that only adds members to an otherwise empty group has no
    // other recipients, just the welcome's.
    let recipients = delivery::parse_recipients(&send.recipient_devices, send.welcome.is_some())?;
    let welcome_recipients = match &send.welcome {
        Some(_) => delivery::parse_recipients(&send.welcome_recipients, false)?,
        None => Vec::new(),
    };
    let outcome = delivery::send(
        db,
        delivery::Send {
            sender,
            envelope: &envelope,
            recipients: &recipients,
            welcome: send
                .welcome
                .as_ref()
                .map(|w| (w, welcome_recipients.as_slice())),
        },
    )
    .await?;
    if outcome == SendOutcome::Accepted {
        for device in recipients.iter().chain(&welcome_recipients) {
            if !state.hub.wake(device)
                && let Some(push) = state.push.clone()
            {
                // Offline: a content-free Web Push makes it reconnect.
                let (db, device) = (db.clone(), *device);
                tokio::spawn(async move { push.notify(&db, device).await });
            }
        }
    }
    Ok(Some(server_frame::Body::SendResult(SendResult {
        accepted: outcome == SendOutcome::Accepted,
        epoch_conflict: outcome == SendOutcome::EpochConflict,
    })))
}

async fn recv_wake(authed: &mut Option<Authed>) -> Option<()> {
    match authed {
        Some(a) => a.wake.recv().await,
        None => std::future::pending().await,
    }
}

fn reply(request_id: u64, body: server_frame::Body) -> ServerFrame {
    ServerFrame {
        request_id,
        body: Some(body),
    }
}

fn api_error(request_id: u64, e: &ApiError) -> ServerFrame {
    if let ApiError::Internal(err) = e {
        tracing::error!(error = %err, "websocket request failed");
    }
    error(request_id, u32::from(e.status().as_u16()), e.message())
}

fn error(request_id: u64, code: u32, message: &str) -> ServerFrame {
    reply(
        request_id,
        server_frame::Body::Error(Error {
            code,
            message: message.to_owned(),
        }),
    )
}

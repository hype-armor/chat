//! JavaScript bindings used by the web client's core worker.

use chat_proto::v1::{
    Ack, Authenticate, ClientFrame, Content, ContentType, Envelope, GroupInfo, Ping, Profile,
    SendEnvelope, ServerFrame, Text, client_frame, content, server_frame,
};
use js_sys::{Array, Uint8Array};
use prost::Message;
use wasm_bindgen::prelude::*;

use crate::{
    client::{Client, Event},
    mls::{Conversation, Device, PendingDevice, Received},
};

fn js_err(e: crate::Error) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Two in-memory devices create a conversation and exchange a message.
/// Proves MLS works in this browser (Phase 0 spike a).
#[wasm_bindgen]
pub fn self_test() -> Result<bool, JsError> {
    let alice = Device::new(b"alice").map_err(js_err)?;
    let bob = Device::new(b"bob").map_err(js_err)?;
    let mut a = Conversation::create(&alice).map_err(js_err)?;
    let change = a
        .add_members(&alice, &[&bob.key_package().map_err(js_err)?])
        .map_err(js_err)?;
    let mut b = Conversation::join(&bob, &change.welcome).map_err(js_err)?;
    let ct = a.encrypt(&alice, b"ping").map_err(js_err)?;
    Ok(matches!(
        b.receive(&bob, &ct).map_err(js_err)?,
        Received::Application { data, .. } if data == b"ping"
    ))
}

/// Builds an N-member group so JavaScript can time membership commits
/// (NFR-PERF-5: < 200 ms for 50 members on a mid-range phone).
#[wasm_bindgen]
pub struct GroupBench {
    creator: Device,
    conv: Conversation,
}

#[wasm_bindgen]
impl GroupBench {
    #[wasm_bindgen(constructor)]
    pub fn new(members: u32) -> Result<GroupBench, JsError> {
        let creator = Device::new(b"creator").map_err(js_err)?;
        let others = (1..members.max(1))
            .map(|i| Device::new(format!("m{i}").as_bytes()))
            .collect::<crate::Result<Vec<_>>>()
            .map_err(js_err)?;
        let kps = others
            .iter()
            .map(Device::key_package)
            .collect::<crate::Result<Vec<_>>>()
            .map_err(js_err)?;
        let refs: Vec<&[u8]> = kps.iter().map(Vec::as_slice).collect();
        let mut conv = Conversation::create(&creator).map_err(js_err)?;
        if !refs.is_empty() {
            conv.add_members(&creator, &refs).map_err(js_err)?;
        }
        Ok(GroupBench { creator, conv })
    }

    #[wasm_bindgen(js_name = memberCount)]
    pub fn member_count(&self) -> u32 {
        self.conv.member_count() as u32
    }

    /// Creates and applies one self-update commit; returns its size in bytes.
    #[wasm_bindgen(js_name = commitUpdate)]
    pub fn commit_update(&mut self) -> Result<u32, JsError> {
        Ok(self.conv.self_update(&self.creator).map_err(js_err)?.len() as u32)
    }
}

// ---- Client state -------------------------------------------------------

fn bytes_array(items: impl IntoIterator<Item = Vec<u8>>) -> Array {
    items
        .into_iter()
        .map(|b| Uint8Array::from(b.as_slice()))
        .collect()
}

fn array_bytes(array: &Array) -> Vec<Vec<u8>> {
    array.iter().map(|v| Uint8Array::new(&v).to_vec()).collect()
}

/// A signing key awaiting registration: send `publicKey` to the server,
/// then turn it into a client with the identity the server assigns.
#[wasm_bindgen]
pub struct PendingClient {
    inner: Option<PendingDevice>,
}

#[wasm_bindgen]
impl PendingClient {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<PendingClient, JsError> {
        Ok(Self {
            inner: Some(PendingDevice::generate().map_err(js_err)?),
        })
    }

    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Result<Vec<u8>, JsError> {
        Ok(self.pending()?.public_key().to_vec())
    }

    /// Consumes the pending key. `identity` is account id ‖ device id.
    #[wasm_bindgen(js_name = intoClient)]
    pub fn into_client(&mut self, identity: &[u8]) -> Result<CoreClient, JsError> {
        let pending = self
            .inner
            .take()
            .ok_or_else(|| JsError::new("pending key already used"))?;
        Ok(CoreClient {
            inner: Client::new(pending.into_device(identity).map_err(js_err)?),
        })
    }

    fn pending(&self) -> Result<&PendingDevice, JsError> {
        self.inner
            .as_ref()
            .ok_or_else(|| JsError::new("pending key already used"))
    }
}

#[wasm_bindgen(getter_with_clone)]
pub struct StartedView {
    #[wasm_bindgen(js_name = conversationId)]
    pub conversation_id: Vec<u8>,
    /// Encoded welcome `Envelope` for the invited devices.
    pub welcome: Vec<u8>,
}

#[wasm_bindgen(getter_with_clone)]
pub struct AddedView {
    /// Encoded handshake `Envelope` for the existing members.
    pub commit: Vec<u8>,
    /// Encoded welcome `Envelope` for the new devices.
    pub welcome: Vec<u8>,
    /// SHA-256 of the commit ciphertext (compare with `/v1/groups/epoch`).
    #[wasm_bindgen(js_name = commitHash)]
    pub commit_hash: Vec<u8>,
}

/// A received envelope, flattened for JavaScript. `kind` is one of
/// `message`, `joined`, `epoch`, `ignored`.
#[wasm_bindgen]
pub struct EventView {
    #[wasm_bindgen(getter_with_clone)]
    pub kind: String,
    #[wasm_bindgen(getter_with_clone, js_name = conversationId)]
    pub conversation_id: Vec<u8>,
    #[wasm_bindgen(getter_with_clone)]
    pub sender: Vec<u8>,
    #[wasm_bindgen(js_name = sentAtMs)]
    pub sent_at_ms: f64,
    #[wasm_bindgen(getter_with_clone)]
    pub text: Option<String>,
    #[wasm_bindgen(getter_with_clone, js_name = displayName)]
    pub display_name: Option<String>,
    #[wasm_bindgen(getter_with_clone, js_name = groupName)]
    pub group_name: Option<String>,
}

impl EventView {
    fn new(kind: &str, conversation_id: Vec<u8>) -> Self {
        Self {
            kind: kind.to_owned(),
            conversation_id,
            sender: Vec::new(),
            sent_at_ms: 0.0,
            text: None,
            display_name: None,
            group_name: None,
        }
    }
}

#[wasm_bindgen]
pub struct CoreClient {
    inner: Client,
}

#[wasm_bindgen]
impl CoreClient {
    pub fn restore(snapshot: &[u8]) -> Result<CoreClient, JsError> {
        Ok(Self {
            inner: Client::restore(snapshot).map_err(js_err)?,
        })
    }

    /// Contains private keys: encrypt before storing.
    pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
        self.inner.snapshot().map_err(js_err)
    }

    pub fn identity(&self) -> Vec<u8> {
        self.inner.identity().to_vec()
    }

    #[wasm_bindgen(js_name = keyPackages)]
    pub fn key_packages(&self, count: u32) -> Result<Array, JsError> {
        Ok(bytes_array(
            self.inner.key_packages(count as usize).map_err(js_err)?,
        ))
    }

    #[wasm_bindgen(js_name = conversationIds)]
    pub fn conversation_ids(&self) -> Array {
        bytes_array(self.inner.conversation_ids())
    }

    pub fn members(&self, conversation_id: &[u8]) -> Result<Array, JsError> {
        Ok(bytes_array(
            self.inner.members(conversation_id).map_err(js_err)?,
        ))
    }

    /// Stages adding devices; see `Client::add_members`. Returns encoded
    /// commit and welcome envelopes.
    #[wasm_bindgen(js_name = addMembers)]
    pub fn add_members(
        &mut self,
        conversation_id: &[u8],
        key_packages: &Array,
        commit_id: Vec<u8>,
        welcome_id: Vec<u8>,
    ) -> Result<AddedView, JsError> {
        let kps = array_bytes(key_packages);
        let refs: Vec<&[u8]> = kps.iter().map(Vec::as_slice).collect();
        let added = self
            .inner
            .add_members(conversation_id, &refs, commit_id, welcome_id)
            .map_err(js_err)?;
        Ok(AddedView {
            commit_hash: added.commit_hash,
            commit: added.commit.encode_to_vec(),
            welcome: added.welcome.encode_to_vec(),
        })
    }

    #[wasm_bindgen(js_name = confirmCommit)]
    pub fn confirm_commit(&mut self, conversation_id: &[u8]) -> Result<(), JsError> {
        self.inner.confirm_commit(conversation_id).map_err(js_err)
    }

    #[wasm_bindgen(js_name = discardCommit)]
    pub fn discard_commit(&mut self, conversation_id: &[u8]) -> Result<(), JsError> {
        self.inner.discard_commit(conversation_id).map_err(js_err)
    }

    #[wasm_bindgen(js_name = sendGroupInfo)]
    pub fn send_group_info(
        &mut self,
        conversation_id: &[u8],
        name: String,
        sent_at_ms: f64,
        message_id: Vec<u8>,
    ) -> Result<Vec<u8>, JsError> {
        self.send(
            conversation_id,
            sent_at_ms,
            content::Body::GroupInfo(GroupInfo { name }),
            message_id,
        )
    }

    #[wasm_bindgen(js_name = startConversation)]
    pub fn start_conversation(
        &mut self,
        key_packages: &Array,
        message_id: Vec<u8>,
    ) -> Result<StartedView, JsError> {
        let kps = array_bytes(key_packages);
        let refs: Vec<&[u8]> = kps.iter().map(Vec::as_slice).collect();
        let started = self
            .inner
            .start_conversation(&refs, message_id)
            .map_err(js_err)?;
        Ok(StartedView {
            conversation_id: started.conversation_id,
            welcome: started.welcome.encode_to_vec(),
        })
    }

    /// Returns the encoded `Envelope`.
    #[wasm_bindgen(js_name = sendText)]
    pub fn send_text(
        &mut self,
        conversation_id: &[u8],
        body: String,
        sent_at_ms: f64,
        message_id: Vec<u8>,
    ) -> Result<Vec<u8>, JsError> {
        self.send(
            conversation_id,
            sent_at_ms,
            content::Body::Text(Text { body }),
            message_id,
        )
    }

    #[wasm_bindgen(js_name = sendProfile)]
    pub fn send_profile(
        &mut self,
        conversation_id: &[u8],
        display_name: String,
        sent_at_ms: f64,
        message_id: Vec<u8>,
    ) -> Result<Vec<u8>, JsError> {
        self.send(
            conversation_id,
            sent_at_ms,
            content::Body::Profile(Profile { display_name }),
            message_id,
        )
    }

    /// Decrypts an encoded `Envelope`.
    pub fn receive(&mut self, envelope: &[u8]) -> Result<EventView, JsError> {
        let env = Envelope::decode(envelope).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(match self.inner.receive(&env).map_err(js_err)? {
            Event::Message {
                conversation_id,
                sender,
                content,
            } => {
                let mut view = EventView::new("message", conversation_id);
                view.sender = sender;
                view.sent_at_ms = content.sent_at_ms as f64;
                match content.body {
                    Some(content::Body::Text(t)) => view.text = Some(t.body),
                    Some(content::Body::Profile(p)) => view.display_name = Some(p.display_name),
                    Some(content::Body::GroupInfo(g)) => view.group_name = Some(g.name),
                    None => view.kind = "ignored".to_owned(),
                }
                view
            }
            Event::Joined { conversation_id } => EventView::new("joined", conversation_id),
            Event::EpochChanged {
                conversation_id, ..
            } => EventView::new("epoch", conversation_id),
            Event::Ignored => EventView::new("ignored", env.conversation_id),
        })
    }

    fn send(
        &mut self,
        conversation_id: &[u8],
        sent_at_ms: f64,
        body: content::Body,
        message_id: Vec<u8>,
    ) -> Result<Vec<u8>, JsError> {
        let content = Content {
            sent_at_ms: sent_at_ms as u64,
            body: Some(body),
        };
        Ok(self
            .inner
            .send(conversation_id, &content, message_id)
            .map_err(js_err)?
            .encode_to_vec())
    }
}

// ---- WebSocket frames (docs/11-api.md) ------------------------------------

fn client_frame(request_id: u32, body: client_frame::Body) -> Vec<u8> {
    ClientFrame {
        request_id: request_id.into(),
        body: Some(body),
    }
    .encode_to_vec()
}

#[wasm_bindgen(js_name = encodeAuthenticate)]
pub fn encode_authenticate(request_id: u32, token: String) -> Vec<u8> {
    client_frame(
        request_id,
        client_frame::Body::Authenticate(Authenticate { token }),
    )
}

#[wasm_bindgen(js_name = encodeSend)]
pub fn encode_send(
    request_id: u32,
    envelope: &[u8],
    recipients: &Array,
) -> Result<Vec<u8>, JsError> {
    let envelope = Envelope::decode(envelope).map_err(|e| JsError::new(&e.to_string()))?;
    let send = SendEnvelope {
        envelope: Some(envelope),
        recipient_devices: array_bytes(recipients),
    };
    Ok(client_frame(request_id, client_frame::Body::Send(send)))
}

#[wasm_bindgen(js_name = encodeAck)]
pub fn encode_ack(request_id: u32, message_id: Vec<u8>) -> Vec<u8> {
    client_frame(request_id, client_frame::Body::Ack(Ack { message_id }))
}

#[wasm_bindgen(js_name = encodePing)]
pub fn encode_ping(request_id: u32) -> Vec<u8> {
    client_frame(request_id, client_frame::Body::Ping(Ping {}))
}

/// A decoded `ServerFrame`. `kind` is one of `auth`, `deliver`,
/// `send_result`, `pong`, `error`, `empty`.
#[wasm_bindgen]
pub struct ServerFrameView {
    #[wasm_bindgen(js_name = requestId)]
    pub request_id: u32,
    #[wasm_bindgen(getter_with_clone)]
    pub kind: String,
    #[wasm_bindgen(getter_with_clone, js_name = deviceId)]
    pub device_id: Vec<u8>,
    /// Encoded `Envelope` for `deliver`.
    #[wasm_bindgen(getter_with_clone)]
    pub envelope: Vec<u8>,
    #[wasm_bindgen(getter_with_clone, js_name = messageId)]
    pub message_id: Vec<u8>,
    /// Conversation of a delivered envelope.
    #[wasm_bindgen(getter_with_clone, js_name = conversationId)]
    pub conversation_id: Vec<u8>,
    /// Whether a delivered envelope is an MLS welcome.
    pub welcome: bool,
    pub accepted: bool,
    #[wasm_bindgen(js_name = epochConflict)]
    pub epoch_conflict: bool,
    #[wasm_bindgen(js_name = errorCode)]
    pub error_code: u32,
    #[wasm_bindgen(getter_with_clone, js_name = errorMessage)]
    pub error_message: String,
}

#[wasm_bindgen(js_name = decodeServerFrame)]
pub fn decode_server_frame(bytes: &[u8]) -> Result<ServerFrameView, JsError> {
    let frame = ServerFrame::decode(bytes).map_err(|e| JsError::new(&e.to_string()))?;
    let mut view = ServerFrameView {
        request_id: u32::try_from(frame.request_id).unwrap_or(u32::MAX),
        kind: "empty".to_owned(),
        device_id: Vec::new(),
        envelope: Vec::new(),
        message_id: Vec::new(),
        conversation_id: Vec::new(),
        welcome: false,
        accepted: false,
        epoch_conflict: false,
        error_code: 0,
        error_message: String::new(),
    };
    match frame.body {
        Some(server_frame::Body::AuthResult(a)) => {
            view.kind = "auth".to_owned();
            view.device_id = a.device_id;
        }
        Some(server_frame::Body::Deliver(env)) => {
            view.kind = "deliver".to_owned();
            view.message_id = env.message_id.clone();
            view.conversation_id = env.conversation_id.clone();
            view.welcome = env.content_type == i32::from(ContentType::Welcome);
            view.envelope = env.encode_to_vec();
        }
        Some(server_frame::Body::SendResult(r)) => {
            view.kind = "send_result".to_owned();
            view.accepted = r.accepted;
            view.epoch_conflict = r.epoch_conflict;
        }
        Some(server_frame::Body::Pong(_)) => view.kind = "pong".to_owned(),
        Some(server_frame::Body::Error(e)) => {
            view.kind = "error".to_owned();
            view.error_code = e.code;
            view.error_message = e.message;
        }
        None => {}
    }
    Ok(view)
}

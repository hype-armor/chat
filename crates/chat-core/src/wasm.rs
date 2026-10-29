//! JavaScript bindings used by the web client's core worker.

use chat_proto::v1::{
    Ack, Attachment, Authenticate, ClientFrame, Content, ContentType, DeviceSync, Envelope,
    GroupInfo, Ping, Profile, Receipt, SendEnvelope, ServerFrame, Text, client_frame, content,
    receipt, server_frame,
};
use js_sys::{Array, Uint8Array};
use prost::Message;
use wasm_bindgen::prelude::*;

use crate::{
    attachment::{Opener, Sealer},
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

/// A staged commit without new members.
#[wasm_bindgen(getter_with_clone)]
pub struct StagedView {
    /// Encoded handshake `Envelope` for every current member.
    pub commit: Vec<u8>,
    #[wasm_bindgen(js_name = commitHash)]
    pub commit_hash: Vec<u8>,
}

impl From<crate::client::Staged> for StagedView {
    fn from(staged: crate::client::Staged) -> Self {
        Self {
            commit: staged.commit.encode_to_vec(),
            commit_hash: staged.commit_hash,
        }
    }
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
/// `message`, `joined`, `epoch`, `proposal`, `ignored`.
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
    /// Admin account ids from a `GroupInfo`, 16 bytes each, concatenated.
    #[wasm_bindgen(getter_with_clone, js_name = groupAdmins)]
    pub group_admins: Vec<u8>,
    /// `DeviceSync` state from one of the account's own devices.
    #[wasm_bindgen(getter_with_clone, js_name = deviceSync)]
    pub device_sync: Option<Vec<u8>>,
    /// Receipts: 0 delivered, 1 read.
    #[wasm_bindgen(js_name = receiptKind)]
    pub receipt_kind: Option<u8>,
    /// Receipted message ids, 16 bytes each, concatenated.
    #[wasm_bindgen(getter_with_clone, js_name = receiptIds)]
    pub receipt_ids: Vec<u8>,
    #[wasm_bindgen(getter_with_clone)]
    pub attachment: Option<AttachmentView>,
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
            group_admins: Vec::new(),
            device_sync: None,
            receipt_kind: None,
            receipt_ids: Vec::new(),
            attachment: None,
        }
    }
}

/// An `Attachment` message body (ADR-0024).
#[wasm_bindgen]
#[derive(Clone)]
pub struct AttachmentView {
    #[wasm_bindgen(getter_with_clone, js_name = blobId)]
    pub blob_id: Vec<u8>,
    #[wasm_bindgen(getter_with_clone)]
    pub key: Vec<u8>,
    #[wasm_bindgen(getter_with_clone)]
    pub digest: Vec<u8>,
    pub size: f64,
    #[wasm_bindgen(getter_with_clone)]
    pub mime: String,
    #[wasm_bindgen(getter_with_clone)]
    pub name: String,
    pub width: u32,
    pub height: u32,
    #[wasm_bindgen(getter_with_clone)]
    pub thumbnail: Vec<u8>,
    #[wasm_bindgen(getter_with_clone)]
    pub caption: String,
}

#[wasm_bindgen]
impl AttachmentView {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        blob_id: Vec<u8>,
        key: Vec<u8>,
        digest: Vec<u8>,
        size: f64,
        mime: String,
        name: String,
        width: u32,
        height: u32,
        thumbnail: Vec<u8>,
        caption: String,
    ) -> AttachmentView {
        AttachmentView {
            blob_id,
            key,
            digest,
            size,
            mime,
            name,
            width,
            height,
            thumbnail,
            caption,
        }
    }
}

impl From<Attachment> for AttachmentView {
    fn from(a: Attachment) -> Self {
        Self {
            blob_id: a.blob_id,
            key: a.key,
            digest: a.digest,
            size: a.size as f64,
            mime: a.mime,
            name: a.name,
            width: a.width,
            height: a.height,
            thumbnail: a.thumbnail,
            caption: a.caption,
        }
    }
}

impl From<AttachmentView> for Attachment {
    fn from(a: AttachmentView) -> Self {
        Self {
            blob_id: a.blob_id,
            key: a.key,
            digest: a.digest,
            size: a.size as u64,
            mime: a.mime,
            name: a.name,
            width: a.width,
            height: a.height,
            thumbnail: a.thumbnail,
            caption: a.caption,
        }
    }
}

/// Encrypts a file piece by piece for upload (ADR-0024).
#[wasm_bindgen]
pub struct AttachmentSealer {
    inner: Option<Sealer>,
}

/// What `AttachmentSealer.finish` returns.
#[wasm_bindgen]
pub struct SealedView {
    /// The last ciphertext bytes.
    #[wasm_bindgen(getter_with_clone)]
    pub tail: Vec<u8>,
    pub size: f64,
    #[wasm_bindgen(getter_with_clone)]
    pub digest: Vec<u8>,
}

#[wasm_bindgen]
impl AttachmentSealer {
    /// `key`: 32 random bytes.
    #[wasm_bindgen(constructor)]
    pub fn new(key: &[u8]) -> Result<AttachmentSealer, JsError> {
        Ok(Self {
            inner: Some(Sealer::new(key).map_err(js_err)?),
        })
    }

    pub fn push(&mut self, data: &[u8]) -> Result<Vec<u8>, JsError> {
        let sealer = self.inner.as_mut().ok_or(JsError::new("sealer finished"))?;
        sealer.push(data).map_err(js_err)
    }

    pub fn finish(&mut self) -> Result<SealedView, JsError> {
        let sealer = self.inner.take().ok_or(JsError::new("sealer finished"))?;
        let sealed = sealer.finish().map_err(js_err)?;
        Ok(SealedView {
            tail: sealed.tail,
            size: sealed.size as f64,
            digest: sealed.digest,
        })
    }
}

/// Decrypts and checks a downloaded file piece by piece (ADR-0024).
#[wasm_bindgen]
pub struct AttachmentOpener {
    inner: Option<Opener>,
}

#[wasm_bindgen]
impl AttachmentOpener {
    #[wasm_bindgen(constructor)]
    pub fn new(key: &[u8], size: f64, digest: &[u8]) -> Result<AttachmentOpener, JsError> {
        Ok(Self {
            inner: Some(Opener::new(key, size as u64, digest).map_err(js_err)?),
        })
    }

    pub fn push(&mut self, data: &[u8]) -> Result<Vec<u8>, JsError> {
        let opener = self.inner.as_mut().ok_or(JsError::new("opener finished"))?;
        opener.push(data).map_err(js_err)
    }

    /// The last plaintext bytes; throws unless the whole file checks out.
    pub fn finish(&mut self) -> Result<Vec<u8>, JsError> {
        let opener = self.inner.take().ok_or(JsError::new("opener finished"))?;
        opener.finish().map_err(js_err)
    }
}

/// Ciphertext size of a file of `len` bytes, padding included.
#[wasm_bindgen(js_name = sealedLength)]
pub fn sealed_length(len: f64) -> f64 {
    crate::attachment::sealed_len(len as u64) as f64
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
    /// `[identity, signatureKey]` pairs, in leaf order (ADR-0020).
    #[wasm_bindgen(js_name = memberKeys)]
    pub fn member_keys(&self, conversation_id: &[u8]) -> Result<Array, JsError> {
        Ok(self
            .inner
            .member_keys(conversation_id)
            .map_err(js_err)?
            .into_iter()
            .map(|(identity, key)| bytes_array([identity, key]))
            .collect())
    }

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
    /// `admins`: account ids (16 bytes each) in priority order.
    pub fn send_group_info(
        &mut self,
        conversation_id: &[u8],
        name: String,
        admins: &Array,
        sent_at_ms: f64,
        message_id: Vec<u8>,
    ) -> Result<Vec<u8>, JsError> {
        let admins = array_bytes(admins);
        self.send(
            conversation_id,
            sent_at_ms,
            content::Body::GroupInfo(GroupInfo { name, admins }),
            message_id,
        )
    }

    /// Stages removing all devices of the given account ids.
    #[wasm_bindgen(js_name = removeMembers)]
    pub fn remove_members(
        &mut self,
        conversation_id: &[u8],
        accounts: &Array,
        commit_id: Vec<u8>,
    ) -> Result<StagedView, JsError> {
        let accounts = array_bytes(accounts);
        let refs: Vec<&[u8]> = accounts.iter().map(Vec::as_slice).collect();
        let staged = self
            .inner
            .remove_members(conversation_id, &refs, commit_id)
            .map_err(js_err)?;
        Ok(StagedView::from(staged))
    }

    /// Stages a commit of received proposals (members leaving).
    #[wasm_bindgen(js_name = commitProposals)]
    pub fn commit_proposals(
        &mut self,
        conversation_id: &[u8],
        commit_id: Vec<u8>,
    ) -> Result<StagedView, JsError> {
        let staged = self
            .inner
            .commit_proposals(conversation_id, commit_id)
            .map_err(js_err)?;
        Ok(StagedView::from(staged))
    }

    /// Returns the encoded `Envelope` of a proposal removing this device.
    pub fn leave(
        &mut self,
        conversation_id: &[u8],
        message_id: Vec<u8>,
    ) -> Result<Vec<u8>, JsError> {
        Ok(self
            .inner
            .leave(conversation_id, message_id)
            .map_err(js_err)?
            .encode_to_vec())
    }

    #[wasm_bindgen(js_name = isActive)]
    pub fn is_active(&self, conversation_id: &[u8]) -> Result<bool, JsError> {
        self.inner.is_active(conversation_id).map_err(js_err)
    }

    #[wasm_bindgen(js_name = hasPendingProposals)]
    pub fn has_pending_proposals(&self, conversation_id: &[u8]) -> Result<bool, JsError> {
        self.inner
            .has_pending_proposals(conversation_id)
            .map_err(js_err)
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

    /// Returns the encoded `Envelope`.
    #[wasm_bindgen(js_name = sendAttachment)]
    pub fn send_attachment(
        &mut self,
        conversation_id: &[u8],
        attachment: &AttachmentView,
        sent_at_ms: f64,
        message_id: Vec<u8>,
    ) -> Result<Vec<u8>, JsError> {
        self.send(
            conversation_id,
            sent_at_ms,
            content::Body::Attachment(attachment.clone().into()),
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

    /// `read`: read receipt, else delivered. Ids are 16-byte message ids.
    #[wasm_bindgen(js_name = sendReceipt)]
    pub fn send_receipt(
        &mut self,
        conversation_id: &[u8],
        read: bool,
        message_ids: &Array,
        sent_at_ms: f64,
        message_id: Vec<u8>,
    ) -> Result<Vec<u8>, JsError> {
        let kind = if read {
            receipt::Kind::Read
        } else {
            receipt::Kind::Delivered
        };
        self.send(
            conversation_id,
            sent_at_ms,
            content::Body::Receipt(Receipt {
                kind: kind.into(),
                message_ids: array_bytes(message_ids),
            }),
            message_id,
        )
    }

    /// For the account's self conversation only (ADR-0019).
    #[wasm_bindgen(js_name = sendDeviceSync)]
    pub fn send_device_sync(
        &mut self,
        conversation_id: &[u8],
        state: Vec<u8>,
        sent_at_ms: f64,
        message_id: Vec<u8>,
    ) -> Result<Vec<u8>, JsError> {
        self.send(
            conversation_id,
            sent_at_ms,
            content::Body::DeviceSync(DeviceSync { state }),
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
                    Some(content::Body::GroupInfo(g)) => {
                        view.group_name = Some(g.name);
                        view.group_admins = g.admins.concat();
                    }
                    Some(content::Body::DeviceSync(d)) => view.device_sync = Some(d.state),
                    Some(content::Body::Attachment(a)) => view.attachment = Some(a.into()),
                    Some(content::Body::Receipt(r)) => {
                        view.receipt_kind =
                            Some(u8::from(r.kind == i32::from(receipt::Kind::Read)));
                        view.receipt_ids = r
                            .message_ids
                            .into_iter()
                            .filter(|id| id.len() == 16)
                            .flatten()
                            .collect();
                    }
                    None => view.kind = "ignored".to_owned(),
                }
                view
            }
            Event::Joined { conversation_id } => EventView::new("joined", conversation_id),
            Event::EpochChanged {
                conversation_id, ..
            } => EventView::new("epoch", conversation_id),
            Event::Proposal {
                conversation_id,
                sender,
            } => {
                let mut view = EventView::new("proposal", conversation_id);
                view.sender = sender;
                view
            }
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
    silent: bool,
) -> Result<Vec<u8>, JsError> {
    let envelope = Envelope::decode(envelope).map_err(|e| JsError::new(&e.to_string()))?;
    let send = SendEnvelope {
        envelope: Some(envelope),
        recipient_devices: array_bytes(recipients),
        silent,
        ..Default::default()
    };
    Ok(client_frame(request_id, client_frame::Body::Send(send)))
}

/// A commit plus the welcome for the members it adds; the server accepts
/// both together (ADR-0017).
#[wasm_bindgen(js_name = encodeSendWithWelcome)]
pub fn encode_send_with_welcome(
    request_id: u32,
    commit: &[u8],
    recipients: &Array,
    welcome: &[u8],
    welcome_recipients: &Array,
) -> Result<Vec<u8>, JsError> {
    let decode = |bytes: &[u8]| Envelope::decode(bytes).map_err(|e| JsError::new(&e.to_string()));
    let send = SendEnvelope {
        envelope: Some(decode(commit)?),
        recipient_devices: array_bytes(recipients),
        welcome: Some(decode(welcome)?),
        welcome_recipients: array_bytes(welcome_recipients),
        silent: false,
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

/// A decoded `ServerFrame`. `kind` is one of `auth`, `deliver`, `devices_changed`,
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
    /// `auth`: this device's available key packages.
    #[wasm_bindgen(js_name = keyPackages)]
    pub key_packages: u32,
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
        key_packages: 0,
    };
    match frame.body {
        Some(server_frame::Body::DevicesChanged(_)) => view.kind = "devices_changed".to_owned(),
        Some(server_frame::Body::AuthResult(a)) => {
            view.kind = "auth".to_owned();
            view.device_id = a.device_id;
            view.key_packages = a.key_packages;
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

// ---- QR codes (ADR-0019) ----------------------------------------------------

/// A QR code's modules: `size` × `size`, row-major, 1 for dark.
#[wasm_bindgen]
pub struct QrView {
    pub size: u32,
    #[wasm_bindgen(getter_with_clone)]
    pub modules: Vec<u8>,
}

#[wasm_bindgen(js_name = encodeQr)]
pub fn encode_qr(text: &str) -> Result<QrView, JsError> {
    let m = crate::qr::encode(text).ok_or_else(|| JsError::new("text too long for a QR code"))?;
    Ok(QrView {
        size: m.size as u32,
        modules: m.dark.into_iter().map(u8::from).collect(),
    })
}

/// Reads the first QR code in an RGBA image (e.g. a camera frame).
#[wasm_bindgen(js_name = decodeQr)]
pub fn decode_qr(rgba: &[u8], width: u32, height: u32) -> Option<String> {
    let luma: Vec<u8> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| ((u16::from(p[0]) * 77 + u16::from(p[1]) * 150 + u16::from(p[2]) * 29) >> 8) as u8)
        .collect();
    crate::qr::decode(&luma, width as usize, height as usize)
}

/// Safety number for two accounts' device signature keys (ADR-0020).
#[wasm_bindgen(js_name = safetyNumber)]
pub fn safety_number(
    my_account: &[u8],
    my_keys: &Array,
    their_account: &[u8],
    their_keys: &Array,
) -> String {
    crate::safety::safety_number(
        my_account,
        &array_bytes(my_keys),
        their_account,
        &array_bytes(their_keys),
    )
}

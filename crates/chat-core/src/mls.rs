//! MLS conversations (ADR-0002). Every conversation, including 1:1, is an
//! MLS group. Inputs and outputs are TLS-serialized MLS messages so they can
//! cross the WASM boundary and any transport unchanged.

use openmls::prelude::{tls_codec::*, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::{MemoryStorage, RustCrypto};
use openmls_traits::OpenMlsProvider;

use crate::{Error, Result, mls_err};

/// X25519 + AES-128-GCM + Ed25519. Replace with a PQ-hybrid suite once
/// OpenMLS ships one (NFR-SEC-4).
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// Past epochs whose keys are kept, so messages sent just before a
/// membership change (and delivered after it) still decrypt. A small
/// forward-secrecy trade-off: those few epochs' keys live a little longer.
const MAX_PAST_EPOCHS: usize = 5;

/// Exporter label for group-call frame keys (docs/05-media-and-calling.md §4).
const CALL_KEY_LABEL: &str = "chat call sframe";

/// OpenMLS provider whose in-memory key store can be exported and restored,
/// so a browser can persist it between sessions.
#[derive(Default)]
pub struct Provider {
    crypto: RustCrypto,
    storage: MemoryStorage,
}

impl OpenMlsProvider for Provider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &MemoryStorage {
        &self.storage
    }

    fn crypto(&self) -> &RustCrypto {
        &self.crypto
    }

    fn rand(&self) -> &RustCrypto {
        &self.crypto
    }
}

impl Provider {
    pub fn export(&self) -> Vec<(Vec<u8>, Vec<u8>)> {
        let values = self
            .storage
            .values
            .read()
            .unwrap_or_else(|e| e.into_inner());
        values.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn import(entries: Vec<(Vec<u8>, Vec<u8>)>) -> Self {
        let provider = Self::default();
        provider
            .storage
            .values
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .extend(entries);
        provider
    }
}

/// A signing key generated before the device has an identity: the public
/// key is registered with the server, which then assigns the identity.
pub struct PendingDevice {
    signer: SignatureKeyPair,
}

impl PendingDevice {
    pub fn generate() -> Result<Self> {
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(mls_err)?;
        Ok(Self { signer })
    }

    pub fn public_key(&self) -> &[u8] {
        self.signer.public()
    }

    pub fn into_device(self, identity: &[u8]) -> Result<Device> {
        Device::with_signer(Provider::default(), self.signer, identity)
    }
}

/// One device's MLS identity and key store.
pub struct Device {
    provider: Provider,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
}

impl Device {
    pub fn new(identity: &[u8]) -> Result<Self> {
        PendingDevice::generate()?.into_device(identity)
    }

    fn with_signer(provider: Provider, signer: SignatureKeyPair, identity: &[u8]) -> Result<Self> {
        signer.store(provider.storage()).map_err(mls_err)?;
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.public().into(),
        };
        Ok(Self {
            provider,
            signer,
            credential,
        })
    }

    /// Rebuilds a device from an exported key store.
    pub fn restore(provider: Provider, identity: &[u8], public_key: &[u8]) -> Result<Self> {
        let signer = SignatureKeyPair::read(
            provider.storage(),
            public_key,
            CIPHERSUITE.signature_algorithm(),
        )
        .ok_or(Error::Malformed("signing key missing from snapshot"))?;
        Self::with_signer(provider, signer, identity)
    }

    pub fn identity(&self) -> &[u8] {
        credential_identity(&self.credential.credential)
    }

    pub fn public_key(&self) -> &[u8] {
        self.signer.public()
    }

    pub fn provider(&self) -> &Provider {
        &self.provider
    }

    /// A fresh single-use key package, as uploaded to the key directory.
    pub fn key_package(&self) -> Result<Vec<u8>> {
        let bundle = KeyPackage::builder()
            .build(
                CIPHERSUITE,
                &self.provider,
                &self.signer,
                self.credential.clone(),
            )
            .map_err(mls_err)?;
        bundle
            .key_package()
            .tls_serialize_detached()
            .map_err(mls_err)
    }

    fn parse_key_package(&self, bytes: &[u8]) -> Result<KeyPackage> {
        KeyPackageIn::tls_deserialize_exact(bytes)
            .map_err(mls_err)?
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(mls_err)
    }
}

fn credential_identity(credential: &Credential) -> &[u8] {
    // Only basic credentials are ever created; others have no identity.
    match credential.credential_type() {
        CredentialType::Basic => credential.serialized_content(),
        _ => &[],
    }
}

/// Output of a membership change: broadcast `commit` to existing members,
/// send `welcome` to the new ones.
pub struct MembershipChange {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

/// What an incoming message turned out to be.
#[derive(Debug, PartialEq, Eq)]
pub enum Received {
    Application {
        sender: Vec<u8>,
        data: Vec<u8>,
    },
    /// A commit from another member was applied; the epoch advanced.
    EpochChanged(u64),
    /// A proposal was stored for a later commit.
    Proposal,
}

pub struct Conversation {
    group: MlsGroup,
}

impl Conversation {
    pub fn create(device: &Device) -> Result<Self> {
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(MAX_PAST_EPOCHS)
            .build();
        let group = MlsGroup::new(
            &device.provider,
            &device.signer,
            &config,
            device.credential.clone(),
        )
        .map_err(mls_err)?;
        Ok(Self { group })
    }

    pub fn join(device: &Device, welcome: &[u8]) -> Result<Self> {
        let MlsMessageBodyIn::Welcome(welcome) = MlsMessageIn::tls_deserialize_exact(welcome)
            .map_err(mls_err)?
            .extract()
        else {
            return Err(Error::Malformed("expected a welcome message"));
        };
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .max_past_epochs(MAX_PAST_EPOCHS)
            .build();
        let group = StagedWelcome::new_from_welcome(&device.provider, &config, welcome, None)
            .map_err(mls_err)?
            .into_group(&device.provider)
            .map_err(mls_err)?;
        Ok(Self { group })
    }

    /// Reloads a conversation from the device's key store.
    pub fn load(device: &Device, id: &[u8]) -> Result<Option<Self>> {
        let group =
            MlsGroup::load(device.provider.storage(), &GroupId::from_slice(id)).map_err(mls_err)?;
        Ok(group.map(|group| Self { group }))
    }

    pub fn id(&self) -> Vec<u8> {
        self.group.group_id().as_slice().to_vec()
    }

    pub fn epoch(&self) -> u64 {
        self.group.epoch().as_u64()
    }

    pub fn member_count(&self) -> usize {
        self.group.members().count()
    }

    /// Identities of all members, including this device.
    pub fn member_identities(&self) -> Vec<Vec<u8>> {
        self.group
            .members()
            .map(|m| credential_identity(&m.credential).to_vec())
            .collect()
    }

    /// Adds members and applies the commit at once. Only safe when nobody
    /// else can commit concurrently, e.g. a group no one has joined yet.
    pub fn add_members(
        &mut self,
        device: &Device,
        key_packages: &[&[u8]],
    ) -> Result<MembershipChange> {
        let change = self.stage_add_members(device, key_packages)?;
        self.merge_pending_commit(device)?;
        Ok(change)
    }

    /// Creates an add-members commit without applying it. Send the commit,
    /// then call [`Self::merge_pending_commit`] if the delivery service
    /// accepts it, or [`Self::clear_pending_commit`] if another commit won
    /// the epoch (docs/03-architecture.md §5.3).
    pub fn stage_add_members(
        &mut self,
        device: &Device,
        key_packages: &[&[u8]],
    ) -> Result<MembershipChange> {
        let key_packages = key_packages
            .iter()
            .map(|kp| device.parse_key_package(kp))
            .collect::<Result<Vec<_>>>()?;
        let (commit, welcome, _group_info) = self
            .group
            .add_members(&device.provider, &device.signer, &key_packages)
            .map_err(mls_err)?;
        Ok(MembershipChange {
            commit: commit.tls_serialize_detached().map_err(mls_err)?,
            welcome: welcome.tls_serialize_detached().map_err(mls_err)?,
        })
    }

    pub fn has_pending_commit(&self) -> bool {
        self.group.pending_commit().is_some()
    }

    pub fn merge_pending_commit(&mut self, device: &Device) -> Result<()> {
        self.group
            .merge_pending_commit(&device.provider)
            .map_err(mls_err)
    }

    pub fn clear_pending_commit(&mut self, device: &Device) -> Result<()> {
        self.group
            .clear_pending_commit(device.provider.storage())
            .map_err(mls_err)
    }

    /// Rotates this device's leaf key (post-compromise security).
    pub fn self_update(&mut self, device: &Device) -> Result<Vec<u8>> {
        let bundle = self
            .group
            .self_update(
                &device.provider,
                &device.signer,
                LeafNodeParameters::default(),
            )
            .map_err(mls_err)?;
        self.group
            .merge_pending_commit(&device.provider)
            .map_err(mls_err)?;
        bundle.commit().tls_serialize_detached().map_err(mls_err)
    }

    pub fn encrypt(&mut self, device: &Device, plaintext: &[u8]) -> Result<Vec<u8>> {
        self.group
            .create_message(&device.provider, &device.signer, plaintext)
            .map_err(mls_err)?
            .tls_serialize_detached()
            .map_err(mls_err)
    }

    pub fn receive(&mut self, device: &Device, message: &[u8]) -> Result<Received> {
        let message = MlsMessageIn::tls_deserialize_exact(message)
            .map_err(mls_err)?
            .try_into_protocol_message()
            .map_err(mls_err)?;
        let processed = self
            .group
            .process_message(&device.provider, message)
            .map_err(mls_err)?;
        let sender = credential_identity(processed.credential()).to_vec();
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => Ok(Received::Application {
                sender,
                data: app.into_bytes(),
            }),
            ProcessedMessageContent::StagedCommitMessage(commit) => {
                self.group
                    .merge_staged_commit(&device.provider, *commit)
                    .map_err(mls_err)?;
                Ok(Received::EpochChanged(self.epoch()))
            }
            ProcessedMessageContent::ProposalMessage(_)
            | ProcessedMessageContent::ExternalJoinProposalMessage(_) => Ok(Received::Proposal),
        }
    }

    /// Per-call SFrame base key, bound to the current epoch.
    pub fn export_call_key(&self, device: &Device, call_id: &[u8]) -> Result<Vec<u8>> {
        self.group
            .export_secret(device.provider.crypto(), CALL_KEY_LABEL, call_id, 32)
            .map_err(mls_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(sender: &[u8], data: &[u8]) -> Received {
        Received::Application {
            sender: sender.to_vec(),
            data: data.to_vec(),
        }
    }

    fn pair() -> (Device, Conversation, Device, Conversation) {
        let alice = Device::new(b"alice").unwrap();
        let bob = Device::new(b"bob").unwrap();
        let mut a = Conversation::create(&alice).unwrap();
        let change = a
            .add_members(&alice, &[&bob.key_package().unwrap()])
            .unwrap();
        let b = Conversation::join(&bob, &change.welcome).unwrap();
        (alice, a, bob, b)
    }

    #[test]
    fn two_devices_exchange_messages() {
        let (alice, mut a, bob, mut b) = pair();
        assert_eq!(a.id(), b.id());
        assert_eq!(a.epoch(), b.epoch());

        let ct = a.encrypt(&alice, b"hello bob").unwrap();
        assert_eq!(b.receive(&bob, &ct).unwrap(), app(b"alice", b"hello bob"));
        let ct = b.encrypt(&bob, b"hi alice").unwrap();
        assert_eq!(a.receive(&alice, &ct).unwrap(), app(b"bob", b"hi alice"));

        assert_eq!(
            a.export_call_key(&alice, b"call-1").unwrap(),
            b.export_call_key(&bob, b"call-1").unwrap(),
        );
        let mut members = b.member_identities();
        members.sort();
        assert_eq!(members, vec![b"alice".to_vec(), b"bob".to_vec()]);
    }

    #[test]
    fn self_update_advances_epoch_for_everyone() {
        let (alice, mut a, bob, mut b) = pair();
        let old_key = a.export_call_key(&alice, b"c").unwrap();
        let commit = b.self_update(&bob).unwrap();
        assert_eq!(
            a.receive(&alice, &commit).unwrap(),
            Received::EpochChanged(b.epoch())
        );
        assert_ne!(a.export_call_key(&alice, b"c").unwrap(), old_key);
    }

    #[test]
    fn fifty_member_group() {
        let creator = Device::new(b"creator").unwrap();
        let others: Vec<Device> = (1..50)
            .map(|i| Device::new(format!("m{i}").as_bytes()).unwrap())
            .collect();
        let kps: Vec<Vec<u8>> = others.iter().map(|d| d.key_package().unwrap()).collect();
        let kp_refs: Vec<&[u8]> = kps.iter().map(Vec::as_slice).collect();

        let mut conv = Conversation::create(&creator).unwrap();
        let change = conv.add_members(&creator, &kp_refs).unwrap();
        assert_eq!(conv.member_count(), 50);

        let mut last = Conversation::join(&others[48], &change.welcome).unwrap();
        let ct = conv.encrypt(&creator, b"to all").unwrap();
        assert_eq!(
            last.receive(&others[48], &ct).unwrap(),
            app(b"creator", b"to all")
        );
    }

    #[test]
    fn device_and_conversation_survive_export_and_import() {
        let (alice, mut a, bob, b) = pair();
        let id = b.id();
        let epoch = b.epoch();
        let public_key = bob.public_key().to_vec();
        let stored = bob.provider().export();
        drop((bob, b));

        let bob = Device::restore(Provider::import(stored), b"bob", &public_key).unwrap();
        assert_eq!(bob.identity(), b"bob");
        let mut b = Conversation::load(&bob, &id)
            .unwrap()
            .expect("conversation restored");
        assert_eq!(b.epoch(), epoch);
        let ct = a.encrypt(&alice, b"after restart").unwrap();
        assert_eq!(
            b.receive(&bob, &ct).unwrap(),
            app(b"alice", b"after restart")
        );
    }

    #[test]
    fn staged_commit_applies_only_when_merged() {
        let (alice, mut a, bob, mut b) = pair();
        let carol = Device::new(b"carol").unwrap();
        let epoch = a.epoch();

        // Rejected by the delivery service: discard, nothing changes.
        a.stage_add_members(&alice, &[&carol.key_package().unwrap()])
            .unwrap();
        assert!(a.has_pending_commit());
        a.clear_pending_commit(&alice).unwrap();
        assert!(!a.has_pending_commit());
        assert_eq!((a.epoch(), a.member_count()), (epoch, 2));

        // Accepted: merge locally; Bob applies the same commit.
        let change = a
            .stage_add_members(&alice, &[&carol.key_package().unwrap()])
            .unwrap();
        a.merge_pending_commit(&alice).unwrap();
        assert_eq!(
            b.receive(&bob, &change.commit).unwrap(),
            Received::EpochChanged(a.epoch())
        );
        let mut c = Conversation::join(&carol, &change.welcome).unwrap();
        assert_eq!(b.member_count(), 3);
        let ct = b.encrypt(&bob, b"hi carol").unwrap();
        assert_eq!(c.receive(&carol, &ct).unwrap(), app(b"bob", b"hi carol"));
        let ct = c.encrypt(&carol, b"hi all").unwrap();
        assert_eq!(a.receive(&alice, &ct).unwrap(), app(b"carol", b"hi all"));
    }

    #[test]
    fn message_from_the_previous_epoch_still_decrypts() {
        let (alice, mut a, bob, mut b) = pair();
        let in_flight = b.encrypt(&bob, b"sent before the commit").unwrap();
        let commit = a.self_update(&alice).unwrap();
        b.receive(&bob, &commit).unwrap();
        assert_eq!(
            a.receive(&alice, &in_flight).unwrap(),
            app(b"bob", b"sent before the commit")
        );
    }

    #[test]
    fn rejects_garbage() {
        let alice = Device::new(b"alice").unwrap();
        assert!(Conversation::join(&alice, b"not mls").is_err());
        let mut conv = Conversation::create(&alice).unwrap();
        assert!(conv.receive(&alice, &[0u8; 8]).is_err());
    }
}

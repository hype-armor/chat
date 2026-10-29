//! MLS conversations (ADR-0002). Every conversation, including 1:1, is an
//! MLS group. Inputs and outputs are TLS-serialized MLS messages so they can
//! cross the WASM boundary and any transport unchanged.

use openmls::prelude::{tls_codec::*, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

use crate::{Error, Result, mls_err};

/// X25519 + AES-128-GCM + Ed25519. Replace with a PQ-hybrid suite once
/// OpenMLS ships one (NFR-SEC-4).
pub const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

/// Exporter label for group-call frame keys (docs/05-media-and-calling.md §4).
const CALL_KEY_LABEL: &str = "chat call sframe";

/// One device's MLS identity and key store.
pub struct Device {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
}

impl Device {
    pub fn new(identity: &[u8]) -> Result<Self> {
        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).map_err(mls_err)?;
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

/// Output of a membership change: broadcast `commit` to existing members,
/// send `welcome` to the new ones.
pub struct MembershipChange {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

/// What an incoming message turned out to be.
#[derive(Debug, PartialEq, Eq)]
pub enum Received {
    Application(Vec<u8>),
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
            .build();
        let group = StagedWelcome::new_from_welcome(&device.provider, &config, welcome, None)
            .map_err(mls_err)?
            .into_group(&device.provider)
            .map_err(mls_err)?;
        Ok(Self { group })
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

    pub fn add_members(
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
        // Merging immediately assumes the delivery service accepts the
        // commit; real clients wait for its ack (docs/03-architecture.md §5.3).
        self.group
            .merge_pending_commit(&device.provider)
            .map_err(mls_err)?;
        Ok(MembershipChange {
            commit: commit.tls_serialize_detached().map_err(mls_err)?,
            welcome: welcome.tls_serialize_detached().map_err(mls_err)?,
        })
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
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(app) => {
                Ok(Received::Application(app.into_bytes()))
            }
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

    #[test]
    fn two_devices_exchange_messages() {
        let alice = Device::new(b"alice").unwrap();
        let bob = Device::new(b"bob").unwrap();

        let mut alice_conv = Conversation::create(&alice).unwrap();
        let change = alice_conv
            .add_members(&alice, &[&bob.key_package().unwrap()])
            .unwrap();
        let mut bob_conv = Conversation::join(&bob, &change.welcome).unwrap();

        assert_eq!(alice_conv.id(), bob_conv.id());
        assert_eq!(alice_conv.epoch(), bob_conv.epoch());

        let ct = alice_conv.encrypt(&alice, b"hello bob").unwrap();
        assert_eq!(
            bob_conv.receive(&bob, &ct).unwrap(),
            Received::Application(b"hello bob".to_vec())
        );

        let ct = bob_conv.encrypt(&bob, b"hi alice").unwrap();
        assert_eq!(
            alice_conv.receive(&alice, &ct).unwrap(),
            Received::Application(b"hi alice".to_vec())
        );

        assert_eq!(
            alice_conv.export_call_key(&alice, b"call-1").unwrap(),
            bob_conv.export_call_key(&bob, b"call-1").unwrap(),
        );
    }

    #[test]
    fn self_update_advances_epoch_for_everyone() {
        let alice = Device::new(b"alice").unwrap();
        let bob = Device::new(b"bob").unwrap();
        let mut alice_conv = Conversation::create(&alice).unwrap();
        let change = alice_conv
            .add_members(&alice, &[&bob.key_package().unwrap()])
            .unwrap();
        let mut bob_conv = Conversation::join(&bob, &change.welcome).unwrap();

        let old_key = alice_conv.export_call_key(&alice, b"c").unwrap();
        let commit = bob_conv.self_update(&bob).unwrap();
        assert_eq!(
            alice_conv.receive(&alice, &commit).unwrap(),
            Received::EpochChanged(bob_conv.epoch())
        );
        assert_ne!(alice_conv.export_call_key(&alice, b"c").unwrap(), old_key);
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
            Received::Application(b"to all".to_vec())
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

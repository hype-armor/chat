//! One device's complete client state: identity, conversations, typed
//! content, and snapshots for persistence. Transport-agnostic: callers move
//! the returned [`Envelope`]s over the server, the local network or a mesh.

use std::collections::BTreeMap;

use chat_proto::{
    PROTOCOL_VERSION,
    v1::{Content, ContentType, Envelope},
};
use prost::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    Error, Result, envelope,
    mls::{Conversation, Device, Provider, Received},
};

const SNAPSHOT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    identity: Vec<u8>,
    public_key: Vec<u8>,
    storage: Vec<(Vec<u8>, Vec<u8>)>,
    conversations: Vec<Vec<u8>>,
}

/// A new conversation; deliver `welcome` to every invited device.
pub struct Started {
    pub conversation_id: Vec<u8>,
    pub welcome: Envelope,
}

/// A staged commit without new members; see [`Client::remove_members`].
pub struct Staged {
    pub commit: Envelope,
    /// SHA-256 of the commit ciphertext (see [`Added::commit_hash`]).
    pub commit_hash: Vec<u8>,
}

fn envelope(
    conversation_id: &[u8],
    epoch: u64,
    content_type: ContentType,
    ciphertext: Vec<u8>,
    message_id: Vec<u8>,
) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION,
        conversation_id: conversation_id.to_vec(),
        epoch,
        content_type: content_type.into(),
        ciphertext,
        message_id,
    }
}

fn staged(conversation_id: &[u8], epoch: u64, commit: Vec<u8>, commit_id: Vec<u8>) -> Staged {
    Staged {
        commit_hash: Sha256::digest(&commit).to_vec(),
        commit: envelope(
            conversation_id,
            epoch,
            ContentType::Handshake,
            commit,
            commit_id,
        ),
    }
}

/// A staged membership change; see [`Client::add_members`].
pub struct Added {
    pub commit: Envelope,
    pub welcome: Envelope,
    /// SHA-256 of the commit ciphertext, as the server records it for the
    /// epoch it accepts (`POST /v1/groups/epoch`).
    pub commit_hash: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub enum Event {
    Message {
        conversation_id: Vec<u8>,
        sender: Vec<u8>,
        content: Content,
    },
    Joined {
        conversation_id: Vec<u8>,
    },
    EpochChanged {
        conversation_id: Vec<u8>,
        epoch: u64,
    },
    /// A member proposed a change (e.g. leaving) for someone to commit.
    Proposal {
        conversation_id: Vec<u8>,
        sender: Vec<u8>,
    },
    /// Nothing for the user to see (a proposal, or a welcome to a
    /// conversation this device is already in).
    Ignored,
}

pub struct Client {
    device: Device,
    conversations: BTreeMap<Vec<u8>, Conversation>,
}

impl Client {
    pub fn new(device: Device) -> Self {
        Self {
            device,
            conversations: BTreeMap::new(),
        }
    }

    pub fn restore(snapshot: &[u8]) -> Result<Self> {
        let snapshot: Snapshot =
            postcard::from_bytes(snapshot).map_err(|_| Error::Malformed("snapshot"))?;
        if snapshot.version != SNAPSHOT_VERSION {
            return Err(Error::Malformed("unsupported snapshot version"));
        }
        let device = Device::restore(
            Provider::import(snapshot.storage),
            &snapshot.identity,
            &snapshot.public_key,
        )?;
        let mut conversations = BTreeMap::new();
        for id in snapshot.conversations {
            let conv = Conversation::load(&device, &id)?
                .ok_or(Error::Malformed("conversation missing from snapshot"))?;
            conversations.insert(id, conv);
        }
        Ok(Self {
            device,
            conversations,
        })
    }

    /// Everything needed to resume after a restart. Contains private keys:
    /// callers must encrypt it at rest.
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let snapshot = Snapshot {
            version: SNAPSHOT_VERSION,
            identity: self.device.identity().to_vec(),
            public_key: self.device.public_key().to_vec(),
            storage: self.device.provider().export(),
            conversations: self.conversations.keys().cloned().collect(),
        };
        postcard::to_allocvec(&snapshot).map_err(|_| Error::Malformed("snapshot encoding"))
    }

    pub fn identity(&self) -> &[u8] {
        self.device.identity()
    }

    pub fn key_packages(&self, count: usize) -> Result<Vec<Vec<u8>>> {
        (0..count).map(|_| self.device.key_package()).collect()
    }

    pub fn conversation_ids(&self) -> Vec<Vec<u8>> {
        self.conversations.keys().cloned().collect()
    }

    /// Creates a conversation with the devices whose key packages are given.
    pub fn start_conversation(
        &mut self,
        key_packages: &[&[u8]],
        message_id: Vec<u8>,
    ) -> Result<Started> {
        let mut conv = Conversation::create(&self.device)?;
        let change = conv.add_members(&self.device, key_packages)?;
        let conversation_id = conv.id();
        let welcome = Envelope {
            version: PROTOCOL_VERSION,
            conversation_id: conversation_id.clone(),
            epoch: conv.epoch(),
            content_type: ContentType::Welcome.into(),
            ciphertext: change.welcome,
            message_id,
        };
        self.conversations.insert(conversation_id.clone(), conv);
        Ok(Started {
            conversation_id,
            welcome,
        })
    }

    /// Member identities, including this device.
    pub fn members(&self, conversation_id: &[u8]) -> Result<Vec<Vec<u8>>> {
        Ok(self.conversation(conversation_id)?.member_identities())
    }

    /// Stages adding devices to an existing conversation. Send `commit` to
    /// the current members (excluding this device); if the server accepts
    /// it, call [`Self::confirm_commit`] and then deliver `welcome` to the
    /// new devices. On an epoch conflict call [`Self::discard_commit`].
    pub fn add_members(
        &mut self,
        conversation_id: &[u8],
        key_packages: &[&[u8]],
        commit_id: Vec<u8>,
        welcome_id: Vec<u8>,
    ) -> Result<Added> {
        let (device, conv) = self.ready_for_commit(conversation_id)?;
        // Commits are built in the current epoch; the server accepts exactly
        // one commit per epoch.
        let epoch = conv.epoch();
        let change = conv.stage_add_members(device, key_packages)?;
        Ok(Added {
            commit_hash: Sha256::digest(&change.commit).to_vec(),
            commit: envelope(
                conversation_id,
                epoch,
                ContentType::Handshake,
                change.commit,
                commit_id,
            ),
            welcome: envelope(
                conversation_id,
                epoch,
                ContentType::Welcome,
                change.welcome,
                welcome_id,
            ),
        })
    }

    /// Stages removing every device of the given accounts (identity
    /// prefixes). Send the commit to all current members, including the
    /// removed ones, then confirm or discard as for [`Self::add_members`].
    pub fn remove_members(
        &mut self,
        conversation_id: &[u8],
        accounts: &[&[u8]],
        commit_id: Vec<u8>,
    ) -> Result<Staged> {
        let (device, conv) = self.ready_for_commit(conversation_id)?;
        let epoch = conv.epoch();
        let commit = conv.stage_remove_members(device, accounts)?;
        Ok(staged(conversation_id, epoch, commit, commit_id))
    }

    /// Stages a commit of received proposals (e.g. members leaving).
    pub fn commit_proposals(
        &mut self,
        conversation_id: &[u8],
        commit_id: Vec<u8>,
    ) -> Result<Staged> {
        let (device, conv) = self.ready_for_commit(conversation_id)?;
        let epoch = conv.epoch();
        let commit = conv.stage_commit_proposals(device)?;
        Ok(staged(conversation_id, epoch, commit, commit_id))
    }

    /// A proposal removing this device, for the other members to commit.
    pub fn leave(&mut self, conversation_id: &[u8], message_id: Vec<u8>) -> Result<Envelope> {
        let (device, conv) = self.ready_for_commit(conversation_id)?;
        let epoch = conv.epoch();
        let proposal = conv.leave(device)?;
        Ok(envelope(
            conversation_id,
            epoch,
            ContentType::Proposal,
            proposal,
            message_id,
        ))
    }

    /// False once this device has been removed (or its departure committed).
    pub fn is_active(&self, conversation_id: &[u8]) -> Result<bool> {
        Ok(self.conversation(conversation_id)?.is_active())
    }

    pub fn has_pending_proposals(&self, conversation_id: &[u8]) -> Result<bool> {
        Ok(self.conversation(conversation_id)?.has_pending_proposals())
    }

    pub fn confirm_commit(&mut self, conversation_id: &[u8]) -> Result<()> {
        let device = &self.device;
        self.conversations
            .get_mut(conversation_id)
            .ok_or(Error::Malformed("unknown conversation"))?
            .merge_pending_commit(device)
    }

    pub fn discard_commit(&mut self, conversation_id: &[u8]) -> Result<()> {
        let device = &self.device;
        self.conversations
            .get_mut(conversation_id)
            .ok_or(Error::Malformed("unknown conversation"))?
            .clear_pending_commit(device)
    }

    pub fn send(
        &mut self,
        conversation_id: &[u8],
        content: &Content,
        message_id: Vec<u8>,
    ) -> Result<Envelope> {
        let conv = self
            .conversations
            .get_mut(conversation_id)
            .ok_or(Error::Malformed("unknown conversation"))?;
        envelope::seal(conv, &self.device, &content.encode_to_vec(), message_id)
    }

    pub fn receive(&mut self, env: &Envelope) -> Result<Event> {
        if env.content_type == i32::from(ContentType::Welcome) {
            if self.conversations.contains_key(&env.conversation_id) {
                return Ok(Event::Ignored);
            }
            let conv = Conversation::join(&self.device, &env.ciphertext)?;
            let conversation_id = conv.id();
            self.conversations.insert(conversation_id.clone(), conv);
            return Ok(Event::Joined { conversation_id });
        }
        let conv = self
            .conversations
            .get_mut(&env.conversation_id)
            .ok_or(Error::Malformed("unknown conversation"))?;
        Ok(match envelope::open(conv, &self.device, env)? {
            Received::Application { sender, data } => Event::Message {
                conversation_id: env.conversation_id.clone(),
                sender,
                content: Content::decode(data.as_slice())?,
            },
            Received::EpochChanged(epoch) => Event::EpochChanged {
                conversation_id: env.conversation_id.clone(),
                epoch,
            },
            Received::Proposal { sender } => Event::Proposal {
                conversation_id: env.conversation_id.clone(),
                sender,
            },
        })
    }

    /// The device and a conversation without a pending commit.
    fn ready_for_commit(&mut self, conversation_id: &[u8]) -> Result<(&Device, &mut Conversation)> {
        let conv = self
            .conversations
            .get_mut(conversation_id)
            .ok_or(Error::Malformed("unknown conversation"))?;
        if conv.has_pending_commit() {
            return Err(Error::Malformed("a membership change is already pending"));
        }
        Ok((&self.device, conv))
    }

    fn conversation(&self, id: &[u8]) -> Result<&Conversation> {
        self.conversations
            .get(id)
            .ok_or(Error::Malformed("unknown conversation"))
    }
}

#[cfg(test)]
mod tests {
    use chat_proto::v1::{Text, content};

    use super::*;

    fn text(body: &str) -> Content {
        Content {
            sent_at_ms: 1,
            body: Some(content::Body::Text(Text {
                body: body.to_owned(),
            })),
        }
    }

    #[test]
    fn conversation_round_trip_with_restart() {
        let mut alice = Client::new(Device::new(b"alice").unwrap());
        let mut bob = Client::new(Device::new(b"bob").unwrap());
        let kp = bob.key_packages(1).unwrap().remove(0);

        let started = alice.start_conversation(&[&kp], vec![1]).unwrap();
        let id = started.conversation_id.clone();
        assert_eq!(
            bob.receive(&started.welcome).unwrap(),
            Event::Joined {
                conversation_id: id.clone()
            }
        );
        assert_eq!(
            bob.receive(&started.welcome).unwrap(),
            Event::Ignored,
            "duplicate welcome"
        );

        // Both sides restart from snapshots.
        let mut alice = Client::restore(&alice.snapshot().unwrap()).unwrap();
        let mut bob = Client::restore(&bob.snapshot().unwrap()).unwrap();
        assert_eq!(bob.conversation_ids(), vec![id.clone()]);
        assert_eq!(bob.members(&id).unwrap().len(), 2);

        let env = alice.send(&id, &text("hi bob"), vec![2]).unwrap();
        assert_eq!(
            bob.receive(&env).unwrap(),
            Event::Message {
                conversation_id: id.clone(),
                sender: b"alice".to_vec(),
                content: text("hi bob")
            }
        );
        let env = bob.send(&id, &text("hi alice"), vec![3]).unwrap();
        assert!(
            matches!(alice.receive(&env).unwrap(), Event::Message { sender, .. } if sender == b"bob")
        );
    }

    #[test]
    fn add_members_to_an_existing_conversation() {
        let mut alice = Client::new(Device::new(b"alice").unwrap());
        let mut bob = Client::new(Device::new(b"bob").unwrap());
        let mut carol = Client::new(Device::new(b"carol").unwrap());
        let started = alice
            .start_conversation(&[&bob.key_packages(1).unwrap()[0]], vec![1])
            .unwrap();
        let id = started.conversation_id.clone();
        bob.receive(&started.welcome).unwrap();

        let carol_kp = carol.key_packages(1).unwrap().remove(0);
        // A lost race: discard and nothing changes.
        alice
            .add_members(&id, &[&carol_kp], vec![2], vec![3])
            .unwrap();
        assert!(
            alice
                .add_members(&id, &[&carol_kp], vec![2], vec![3])
                .is_err(),
            "one at a time"
        );
        alice.discard_commit(&id).unwrap();
        assert_eq!(alice.members(&id).unwrap().len(), 2);

        let carol_kp = carol.key_packages(1).unwrap().remove(0);
        let added = alice
            .add_members(&id, &[&carol_kp], vec![4], vec![5])
            .unwrap();
        assert_eq!(added.commit.content_type, i32::from(ContentType::Handshake));
        assert_eq!(
            added.commit_hash,
            Sha256::digest(&added.commit.ciphertext).to_vec()
        );
        alice.confirm_commit(&id).unwrap();
        assert!(matches!(
            bob.receive(&added.commit).unwrap(),
            Event::EpochChanged { .. }
        ));
        assert_eq!(
            carol.receive(&added.welcome).unwrap(),
            Event::Joined {
                conversation_id: id.clone()
            }
        );

        let env = carol.send(&id, &text("hello both"), vec![6]).unwrap();
        for client in [&mut alice, &mut bob] {
            assert!(
                matches!(client.receive(&env).unwrap(), Event::Message { sender, .. } if sender == b"carol")
            );
        }
        assert_eq!(bob.members(&id).unwrap().len(), 3);
    }

    #[test]
    fn remove_and_leave_through_the_client() {
        let mut alice = Client::new(Device::new(b"alice-dev").unwrap());
        let mut bob = Client::new(Device::new(b"bob-dev").unwrap());
        let mut carol = Client::new(Device::new(b"carol-dev").unwrap());
        let kps = [
            bob.key_packages(1).unwrap().remove(0),
            carol.key_packages(1).unwrap().remove(0),
        ];
        let started = alice
            .start_conversation(&[&kps[0], &kps[1]], vec![1])
            .unwrap();
        let id = started.conversation_id.clone();
        bob.receive(&started.welcome).unwrap();
        carol.receive(&started.welcome).unwrap();

        // Bob leaves; Alice commits his proposal.
        let proposal = bob.leave(&id, vec![2]).unwrap();
        assert_eq!(proposal.content_type, i32::from(ContentType::Proposal));
        assert_eq!(
            alice.receive(&proposal).unwrap(),
            Event::Proposal {
                conversation_id: id.clone(),
                sender: b"bob-dev".to_vec()
            }
        );
        carol.receive(&proposal).unwrap();
        assert!(alice.has_pending_proposals(&id).unwrap());
        let staged = alice.commit_proposals(&id, vec![3]).unwrap();
        assert_eq!(
            staged.commit_hash,
            Sha256::digest(&staged.commit.ciphertext).to_vec()
        );
        alice.confirm_commit(&id).unwrap();
        bob.receive(&staged.commit).unwrap();
        carol.receive(&staged.commit).unwrap();
        assert!(!bob.is_active(&id).unwrap());
        assert_eq!(carol.members(&id).unwrap().len(), 2);

        // Alice removes Carol.
        let staged = alice.remove_members(&id, &[b"carol"], vec![4]).unwrap();
        alice.confirm_commit(&id).unwrap();
        carol.receive(&staged.commit).unwrap();
        assert!(!carol.is_active(&id).unwrap());
        assert_eq!(alice.members(&id).unwrap(), vec![b"alice-dev".to_vec()]);
    }

    #[test]
    fn rejects_bad_snapshots_and_unknown_conversations() {
        assert!(Client::restore(b"junk").is_err());
        let mut alice = Client::new(Device::new(b"alice").unwrap());
        assert!(alice.send(b"nope", &text("x"), vec![]).is_err());
    }
}

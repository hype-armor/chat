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
            Received::Proposal => Event::Ignored,
        })
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
    fn rejects_bad_snapshots_and_unknown_conversations() {
        assert!(Client::restore(b"junk").is_err());
        let mut alice = Client::new(Device::new(b"alice").unwrap());
        assert!(alice.send(b"nope", &text("x"), vec![]).is_err());
    }
}

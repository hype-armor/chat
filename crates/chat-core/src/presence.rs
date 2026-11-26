//! Validation for a proposed ephemeral MLS presence payload. This module does
//! not authorize transport or establish a current consent generation.

use chat_proto::v1::{PresenceEvent, presence_event::State};

#[path = "presence_binding.rs"]
pub mod binding;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_LEASE_MS: u64 = 60_000;
const MAX_SKEW_MS: u64 = 2_000;

/// Check a payload after MLS authentication. `members` is the authenticated
/// current MLS roster. The caller must independently obtain the current grant
/// and select the direct conversation; cached grants are not authority.
pub fn valid_event(
    event: &PresenceEvent,
    sender: &[u8],
    members: &[Vec<u8>],
    conversation_id: &[u8],
    recipient: &[u8],
    generation: u64,
    now_ms: u64,
) -> bool {
    if sender.len() != 32
        || recipient.len() != 16
        || conversation_id.len() != 16
        || event.conversation_id != conversation_id
        || event.recipient_account != recipient
        || sender[..16] == *recipient
        || generation == 0
        || generation > MAX_SAFE_INTEGER
        || event.consent_generation != generation
        || now_ms > MAX_SAFE_INTEGER
        || !matches!(
            State::try_from(event.state),
            Ok(State::Online | State::Away)
        )
        || event.sent_at_ms == 0
        || event.sent_at_ms > MAX_SAFE_INTEGER
        || event.expires_at_ms > MAX_SAFE_INTEGER
        || event.expires_at_ms <= now_ms
        || event.sent_at_ms > now_ms.saturating_add(MAX_SKEW_MS)
        || event.expires_at_ms <= event.sent_at_ms
        || event.expires_at_ms - event.sent_at_ms > MAX_LEASE_MS
    {
        return false;
    }
    // All leaves must belong to exactly the sender or recipient account. This
    // allows linked devices but excludes self chats and group conversations.
    members
        .iter()
        .all(|id| id.len() == 32 && (id[..16] == sender[..16] || id[..16] == *recipient))
        && members.iter().any(|id| id.as_slice() == sender)
        && members.iter().any(|id| id[..16] == *recipient)
}

#[cfg(test)]
#[path = "presence_ratchet_tests.rs"]
mod ratchet_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mls::{Conversation, Device, JoinPackage, Received};
    use prost::Message;

    #[test]
    fn client_presence_is_ephemeral_and_persists_ratchets() {
        use crate::client::{Client, Event};
        use chat_proto::v1::{Content, Text, content};

        let alice_id = [1; 32];
        let bob_id = [2; 32];
        let mut alice = Client::new(Device::new(&alice_id).unwrap());
        let mut bob = Client::new(Device::new(&bob_id).unwrap());
        let kp = bob.key_packages(1).unwrap().remove(0);
        let started = alice
            .start_conversation(
                &[JoinPackage {
                    identity: &bob_id,
                    key_package: &kp,
                }],
                vec![1],
            )
            .unwrap();
        let id = started.conversation_id;
        bob.receive(&started.welcome).unwrap();
        let event = PresenceEvent {
            conversation_id: id.clone(),
            recipient_account: bob_id[..16].to_vec(),
            consent_generation: 7,
            state: State::Online as i32,
            sent_at_ms: 1_000,
            expires_at_ms: 2_000,
        };
        let wrapped = Content {
            sent_at_ms: 1_000,
            body: Some(content::Body::Presence(event.clone())),
            reply_to: None,
            reply_to_hash: None,
        };
        assert!(alice.send(&id, &wrapped, vec![2]).is_err());
        let ciphertext = alice.encrypt_presence(&event, 1_001).unwrap();
        let mut alice = Client::restore(&alice.snapshot().unwrap()).unwrap();
        assert_eq!(
            bob.receive_presence(&id, &ciphertext, &alice_id[..16], 7, 1_001)
                .unwrap(),
            Some((alice_id.to_vec(), event.clone()))
        );
        let mut bob = Client::restore(&bob.snapshot().unwrap()).unwrap();
        assert!(
            bob.receive_presence(&id, &ciphertext, &alice_id[..16], 7, 1_001)
                .is_err()
        );
        let ciphertext = alice.encrypt_presence(&event, 1_001).unwrap();
        assert_eq!(
            bob.receive_presence(&id, &ciphertext, &alice_id[..16], 8, 1_001)
                .unwrap(),
            None
        );
        let mut bob = Client::restore(&bob.snapshot().unwrap()).unwrap();
        let normal = Content {
            sent_at_ms: 1_001,
            body: Some(content::Body::Text(Text {
                body: "next".into(),
            })),
            reply_to: None,
            reply_to_hash: None,
        };
        let env = alice.send(&id, &normal, vec![3]).unwrap();
        assert!(
            matches!(bob.receive(&env).unwrap(), Event::Message { content, .. } if content == normal)
        );
    }

    #[test]
    fn old_content_decoder_ignores_presence_body() {
        #[derive(Clone, PartialEq, Message)]
        struct OldContent {
            #[prost(uint64, tag = "1")]
            sent_at_ms: u64,
        }
        let content = chat_proto::v1::Content {
            sent_at_ms: 1,
            body: Some(chat_proto::v1::content::Body::Presence(
                PresenceEvent::default(),
            )),
            reply_to: None,
            reply_to_hash: None,
        };
        let old = OldContent::decode(content.encode_to_vec().as_slice()).unwrap();
        assert_eq!(old.sent_at_ms, 1);
        assert_eq!(
            chat_proto::v1::Content::decode(old.encode_to_vec().as_slice())
                .unwrap()
                .body,
            None
        );
    }

    #[test]
    fn mls_authenticates_payload_and_validator_rejects_wrong_context() {
        let alice_id = [1; 32];
        let bob_id = [2; 32];
        let alice = Device::new(&alice_id).unwrap();
        let bob = Device::new(&bob_id).unwrap();
        let mut a = Conversation::create(&alice).unwrap();
        let kp = bob.key_package().unwrap();
        let welcome = a
            .add_members(&alice, &[JoinPackage::of(&bob, &kp)])
            .unwrap();
        let mut b = Conversation::join(&bob, &welcome.welcome).unwrap();
        let id = a.id();
        let event = PresenceEvent {
            conversation_id: id.clone(),
            recipient_account: bob_id[..16].to_vec(),
            consent_generation: 7,
            state: State::Away as i32,
            sent_at_ms: 1_000,
            expires_at_ms: 61_000,
        };
        let ciphertext = a.encrypt(&alice, &event.encode_to_vec()).unwrap();
        let Received::Application { sender, data } = b.receive(&bob, &ciphertext).unwrap() else {
            panic!("expected application message")
        };
        let decoded = PresenceEvent::decode(data.as_slice()).unwrap();
        let roster = b.member_identities();
        let check = |event: &PresenceEvent, members: &[Vec<u8>], generation| {
            valid_event(
                event,
                &sender,
                members,
                &id,
                &bob_id[..16],
                generation,
                1_001,
            )
        };
        assert_eq!(sender, alice_id);
        assert!(check(&decoded, &roster, 7));
        assert!(!check(&decoded, &roster, 8));
        assert!(!check(
            &decoded,
            &[roster.clone(), vec![vec![3; 32]]].concat(),
            7
        ));
        let mut invalid = decoded.clone();
        invalid.recipient_account[0] ^= 1;
        assert!(!check(&invalid, &roster, 7));
        invalid = decoded.clone();
        invalid.expires_at_ms += 1;
        assert!(!check(&invalid, &roster, 7));
        invalid = decoded;
        invalid.state = 0;
        assert!(!check(&invalid, &roster, 7));
    }
}

//! MLS isolation experiment, not an authorization or production protocol.
use chat_core::{
    client::{Client, Event},
    mls::{Device, JoinPackage},
};
use chat_proto::v1::{Content, PresenceEvent, Text, content, presence_event::State};

const ALICE: [u8; 32] = [1; 32];
const BOB: [u8; 32] = [2; 32];

fn group(a: &mut Client, b: &mut Client) -> Vec<u8> {
    let key = b.key_packages(1).unwrap().remove(0);
    let started = a
        .start_conversation(
            &[JoinPackage {
                identity: &BOB,
                key_package: &key,
            }],
            vec![1],
        )
        .unwrap();
    b.receive(&started.welcome).unwrap();
    started.conversation_id
}

fn event(id: &[u8]) -> PresenceEvent {
    PresenceEvent {
        conversation_id: id.to_vec(),
        recipient_account: BOB[..16].to_vec(),
        consent_generation: 7,
        state: State::Online as i32,
        sent_at_ms: 1000,
        expires_at_ms: 61000,
    }
}

fn message() -> Content {
    Content {
        sent_at_ms: 1000,
        body: Some(content::Body::Text(Text {
            body: "ordinary".into(),
        })),
        reply_to: None,
        reply_to_hash: None,
    }
}

#[test]
fn separate_groups_isolate_loss_and_new_group_recovers_presence() {
    let mut alice = Client::new(Device::new(&ALICE).unwrap());
    let mut bob = Client::new(Device::new(&BOB).unwrap());
    let chat = group(&mut alice, &mut bob);
    let presence = group(&mut alice, &mut bob);
    assert_ne!(chat, presence);
    let old = alice.send(&chat, &message(), vec![2]).unwrap();
    let mut latest = Vec::new();
    for _ in 0..1002 {
        latest = alice.encrypt_presence(&event(&presence), 1001).unwrap();
    }
    alice = Client::restore(&alice.snapshot().unwrap()).unwrap();
    bob = Client::restore(&bob.snapshot().unwrap()).unwrap();
    assert!(
        bob.receive_presence(&presence, &latest, &ALICE[..16], 7, 1001)
            .is_err()
    );
    bob = Client::restore(&bob.snapshot().unwrap()).unwrap();
    assert!(
        matches!(bob.receive(&old).unwrap(), Event::Message { content, .. } if content == message())
    );
    let next = alice.send(&chat, &message(), vec![3]).unwrap();
    assert!(matches!(bob.receive(&next).unwrap(), Event::Message { .. }));
    // This proves only MLS mechanics. A real protocol must authenticate and
    // authorize replacement, reject stale welcomes, and synchronize devices.
    let replacement = group(&mut alice, &mut bob);
    assert_ne!(presence, replacement);
    let ciphertext = alice.encrypt_presence(&event(&replacement), 1001).unwrap();
    bob = Client::restore(&bob.snapshot().unwrap()).unwrap();
    assert!(
        bob.receive_presence(&replacement, &ciphertext, &ALICE[..16], 7, 1001)
            .unwrap()
            .is_some()
    );
}

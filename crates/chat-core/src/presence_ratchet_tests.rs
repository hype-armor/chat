use crate::{
    client::{Client, Event},
    mls::{Device, JoinPackage},
};
use chat_proto::v1::{Content, PresenceEvent, Text, content, presence_event::State};

const ALICE: [u8; 32] = [1; 32];
const BOB: [u8; 32] = [2; 32];

fn setup() -> (Client, Client, Client, Vec<u8>, PresenceEvent) {
    let mut alice = Client::new(Device::new(&ALICE).unwrap());
    let mut bob = Client::new(Device::new(&BOB).unwrap());
    let mut bob2_id = BOB;
    bob2_id[16] = 3;
    let mut bob2 = Client::new(Device::new(&bob2_id).unwrap());
    let kp = bob.key_packages(1).unwrap().remove(0);
    let kp2 = bob2.key_packages(1).unwrap().remove(0);
    let started = alice
        .start_conversation(
            &[
                JoinPackage {
                    identity: &BOB,
                    key_package: &kp,
                },
                JoinPackage {
                    identity: &bob2_id,
                    key_package: &kp2,
                },
            ],
            vec![1],
        )
        .unwrap();
    bob.receive(&started.welcome).unwrap();
    bob2.receive(&started.welcome).unwrap();
    let id = started.conversation_id;
    let event = PresenceEvent {
        conversation_id: id.clone(),
        recipient_account: BOB[..16].to_vec(),
        consent_generation: 7,
        state: State::Online as i32,
        sent_at_ms: 1000,
        expires_at_ms: 61000,
    };
    (alice, bob, bob2, id, event)
}

fn restore(client: Client) -> Client {
    Client::restore(&client.snapshot().unwrap()).unwrap()
}

fn normal() -> Content {
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
fn latest_only_gap_at_forward_limit_and_beyond_survives_restore() {
    let (mut alice, bob, bob2, id, event) = setup();
    let mut latest = Vec::new();
    // OpenMLS defaults to a forward distance of 1000. Generations start at 0.
    for _ in 0..=1000 {
        latest = alice.encrypt_presence(&event, 1001).unwrap();
    }
    alice = restore(alice);
    let mut at_limit = restore(bob);
    let mut beyond_limit = restore(bob2);
    assert!(
        at_limit
            .receive_presence(&id, &latest, &ALICE[..16], 7, 1001)
            .unwrap()
            .is_some()
    );
    let next = alice.encrypt_presence(&event, 1001).unwrap();
    assert!(
        beyond_limit
            .receive_presence(&id, &next, &ALICE[..16], 7, 1001)
            .is_err()
    );
    beyond_limit = restore(beyond_limit);
    let ordinary = alice.send(&id, &normal(), vec![2]).unwrap();
    assert!(beyond_limit.receive(&ordinary).is_err());
    // The device that received generation 1000 continues independently.
    at_limit = restore(at_limit);
    assert!(
        matches!(at_limit.receive(&ordinary).unwrap(), Event::Message { content, .. } if content == normal())
    );
}

#[test]
fn latest_presence_can_expire_a_delayed_ordinary_message_key() {
    let (mut alice, bob, bob2, id, event) = setup();
    let old = alice.send(&id, &normal(), vec![2]).unwrap();
    let mut latest = Vec::new();
    for _ in 0..6 {
        latest = alice.encrypt_presence(&event, 1001).unwrap();
    }
    let mut bob = restore(bob);
    let mut bob2 = restore(bob2);
    // One device receives the durable message first; the other polls first.
    assert!(matches!(bob.receive(&old).unwrap(), Event::Message { .. }));
    assert!(
        bob.receive_presence(&id, &latest, &ALICE[..16], 7, 1001)
            .unwrap()
            .is_some()
    );
    assert!(
        bob2.receive_presence(&id, &latest, &ALICE[..16], 7, 1001)
            .unwrap()
            .is_some()
    );
    bob2 = restore(bob2);
    assert!(bob2.receive(&old).is_err());
    let next = alice.send(&id, &normal(), vec![3]).unwrap();
    assert!(matches!(
        bob2.receive(&next).unwrap(),
        Event::Message { .. }
    ));
}

#[test]
fn small_reordering_in_both_directions_survives_restore() {
    let (mut alice, mut bob, mut bob2, id, event) = setup();
    let presence = alice.encrypt_presence(&event, 1001).unwrap();
    let message = alice.send(&id, &normal(), vec![2]).unwrap();
    assert!(matches!(
        bob.receive(&message).unwrap(),
        Event::Message { .. }
    ));
    bob = restore(bob);
    assert!(
        bob.receive_presence(&id, &presence, &ALICE[..16], 7, 1001)
            .unwrap()
            .is_some()
    );
    assert!(
        bob2.receive_presence(&id, &presence, &ALICE[..16], 7, 1001)
            .unwrap()
            .is_some()
    );
    bob2 = restore(bob2);
    assert!(matches!(
        bob2.receive(&message).unwrap(),
        Event::Message { .. }
    ));
}

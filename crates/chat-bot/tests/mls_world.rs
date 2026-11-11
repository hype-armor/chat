use chat_core::{
    client::{Client, Event},
    mls::{Device, JoinPackage},
};
use chat_proto::v1::{Content, Text, content};
use prost::Message;
use uuid::Uuid;

fn identity(member: usize) -> Vec<u8> {
    let account = Uuid::from_u128(0x1000 + member as u128);
    let device = Uuid::from_u128(0x2000 + member as u128);
    [account.as_bytes().as_slice(), device.as_bytes().as_slice()].concat()
}

fn text(body: &str, sent_at_ms: u64) -> Content {
    Content {
        sent_at_ms,
        reply_to: None,
        reply_to_hash: None,
        body: Some(content::Body::Text(Text {
            body: body.to_owned(),
        })),
    }
}

fn deliver_text(
    clients: &mut [Client],
    sender: usize,
    recipients: &[usize],
    id: &[u8],
    body: &str,
) {
    let content = text(body, sender as u64 + 1);
    let envelope = clients[sender]
        .send(id, &content, vec![sender as u8 + 1; 16])
        .unwrap();
    assert!(
        !envelope
            .ciphertext
            .windows(body.len())
            .any(|window| window == body.as_bytes()),
        "MLS ciphertext must not contain the message plaintext",
    );
    for &recipient in recipients {
        let event = clients[recipient].receive(&envelope).unwrap();
        assert_eq!(
            event,
            Event::Message {
                conversation_id: id.to_vec(),
                sender: identity(sender),
                content: content.clone(),
            }
        );
    }
}

fn exercise_group(size: usize) {
    let identities: Vec<Vec<u8>> = (0..size).map(identity).collect();
    assert!(identities.iter().all(|id| id.len() == 32));
    assert_eq!(
        identities
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        size
    );
    let mut clients: Vec<Client> = identities
        .iter()
        .map(|id| Client::new(Device::new(id).unwrap()))
        .collect();
    let packages: Vec<Vec<u8>> = clients
        .iter_mut()
        .map(|client| client.key_packages(1).unwrap().remove(0))
        .collect();
    let joins: Vec<JoinPackage<'_>> = (1..size)
        .map(|member| JoinPackage {
            identity: &identities[member],
            key_package: &packages[member],
        })
        .collect();

    let started = clients[0].start_conversation(&joins, vec![1; 16]).unwrap();
    let conversation_id = started.conversation_id;
    for client in clients.iter_mut().skip(1) {
        assert_eq!(
            client.receive(&started.welcome).unwrap(),
            Event::Joined {
                conversation_id: conversation_id.clone(),
            }
        );
    }

    for (index, client) in clients.iter().enumerate() {
        let mut actual = client.members(&conversation_id).unwrap();
        actual.sort();
        let mut expected = identities.clone();
        expected.sort();
        assert_eq!(
            actual, expected,
            "membership for member {index} in group size {size}"
        );
        assert_eq!(
            client.epoch(&conversation_id).unwrap(),
            1,
            "epoch for member {index}"
        );
    }

    let first_body = format!("MLS world size {size}, sender 0, first message");
    deliver_text(
        &mut clients,
        0,
        &(1..size).collect::<Vec<_>>(),
        &conversation_id,
        &first_body,
    );
    let second_sender = size - 1;
    let second_body = format!("MLS world size {size}, sender {second_sender}, second message");
    deliver_text(
        &mut clients,
        second_sender,
        &(0..second_sender).collect::<Vec<_>>(),
        &conversation_id,
        &second_body,
    );

    clients = clients
        .iter()
        .map(|client| Client::restore(&client.snapshot().unwrap()).unwrap())
        .collect();
    for (index, client) in clients.iter().enumerate() {
        assert_eq!(
            client.epoch(&conversation_id).unwrap(),
            1,
            "restored epoch for member {index}"
        );
        assert_eq!(client.members(&conversation_id).unwrap().len(), size);
    }
    let restored_body = format!("MLS world size {size}, restored sender, message");
    deliver_text(
        &mut clients,
        1,
        &(0..size).filter(|member| *member != 1).collect::<Vec<_>>(),
        &conversation_id,
        &restored_body,
    );
}

#[test]
fn mls_world_two_members_exchange_and_restore() {
    exercise_group(2);
}

#[test]
fn mls_world_three_members_exchange_and_restore() {
    exercise_group(3);
}

#[test]
fn mls_world_ten_members_exchange_and_restore() {
    exercise_group(10);
}

#[test]
fn mls_world_fifty_members_exchange_and_restore() {
    exercise_group(50);
}

#[test]
fn joining_existing_epoch_two_group_reports_epoch_two() {
    let alice_id = identity(100);
    let bob_id = identity(101);
    let carol_id = identity(102);
    let mut alice = Client::new(Device::new(&alice_id).unwrap());
    let mut bob = Client::new(Device::new(&bob_id).unwrap());
    let mut carol = Client::new(Device::new(&carol_id).unwrap());
    let bob_package = bob.key_packages(1).unwrap().remove(0);
    let started = alice
        .start_conversation(
            &[JoinPackage {
                identity: &bob_id,
                key_package: &bob_package,
            }],
            vec![1; 16],
        )
        .unwrap();
    let id = started.conversation_id;
    bob.receive(&started.welcome).unwrap();
    assert_eq!(alice.epoch(&id).unwrap(), 1);
    assert_eq!(bob.epoch(&id).unwrap(), 1);

    let carol_package = carol.key_packages(1).unwrap().remove(0);
    let added = alice
        .add_members(
            &id,
            &[JoinPackage {
                identity: &carol_id,
                key_package: &carol_package,
            }],
            vec![2; 16],
            vec![3; 16],
        )
        .unwrap();
    alice.confirm_commit(&id).unwrap();
    assert!(matches!(
        bob.receive(&added.commit).unwrap(),
        Event::EpochChanged { epoch: 2, .. }
    ));
    assert_eq!(
        carol.receive(&added.welcome).unwrap(),
        Event::Joined {
            conversation_id: id.clone()
        }
    );
    assert_eq!(alice.epoch(&id).unwrap(), 2);
    assert_eq!(bob.epoch(&id).unwrap(), 2);
    assert_eq!(carol.epoch(&id).unwrap(), 2);

    let restored = Client::restore(&carol.snapshot().unwrap()).unwrap();
    assert_eq!(restored.epoch(&id).unwrap(), 2);

    let content = text("joined at epoch two", 10);
    let envelope = carol.send(&id, &content, vec![4; 16]).unwrap();
    for client in [&mut alice, &mut bob] {
        assert!(
            matches!(client.receive(&envelope).unwrap(), Event::Message { content: received, .. } if received == content)
        );
    }
    // Exercise prost encoding in the external integration-test crate as well.
    assert_eq!(
        Content::decode(content.encode_to_vec().as_slice()).unwrap(),
        content
    );
}

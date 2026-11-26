//! Regression tests for the disabled restricted-channel receive path.
use chat_core::mls::{Conversation, Device, JoinPackage, Received};
use chat_core::restricted_channel_binding::{BindingContext, validate_binding};
use chat_proto::v1::RestrictedChannelBinding;
use prost::Message;

#[test]
fn current_direct_roster_does_not_prove_the_ciphertext_audience() {
    let alice_id = [1; 32];
    let bob_id = [2; 32];
    let eve_id = [3; 32];
    let alice = Device::new(&alice_id).unwrap();
    let bob = Device::new(&bob_id).unwrap();
    let eve = Device::new(&eve_id).unwrap();
    let mut direct = Conversation::create(&alice).unwrap();
    let bob_kp = bob.key_package().unwrap();
    let eve_kp = eve.key_package().unwrap();
    let change = direct
        .add_members(
            &alice,
            &[
                JoinPackage::of(&bob, &bob_kp),
                JoinPackage::of(&eve, &eve_kp),
            ],
        )
        .unwrap();
    let mut bob_direct = Conversation::join(&bob, &change.welcome).unwrap();
    let mut eve_direct = Conversation::join(&eve, &change.welcome).unwrap();
    let ciphertext = direct.encrypt(&alice, b"private binding").unwrap();
    assert!(matches!(
        eve_direct.receive(&eve, &ciphertext).unwrap(),
        Received::Application { .. }
    ));
    let commit = direct.stage_remove_members(&alice, &[&eve_id]).unwrap();
    direct.merge_pending_commit(&alice).unwrap();
    assert!(matches!(
        bob_direct.receive(&bob, &commit).unwrap(),
        Received::EpochChanged(_)
    ));
    assert_eq!(bob_direct.member_count(), 2);
    assert!(bob_direct.member_identities().contains(&alice_id.to_vec()));
    assert!(bob_direct.member_identities().contains(&bob_id.to_vec()));
    // The current roster is exactly Alice and Bob, but Eve could decrypt this
    // earlier-epoch message. Received does not expose its authenticated epoch.
    assert!(matches!(
        bob_direct.receive(&bob, &ciphertext).unwrap(),
        Received::Application { .. }
    ));
}

#[test]
fn actual_mls_rosters_require_every_device_of_each_channel_account() {
    let alice_id = [1; 32];
    let mut alice_second_id = alice_id;
    alice_second_id[31] = 9;
    let bob_id = [2; 32];
    let alice = Device::new(&alice_id).unwrap();
    let alice_second = Device::new(&alice_second_id).unwrap();
    let bob = Device::new(&bob_id).unwrap();
    let mut parent = Conversation::create(&alice).unwrap();
    let second_kp = alice_second.key_package().unwrap();
    let bob_kp = bob.key_package().unwrap();
    parent
        .add_members(
            &alice,
            &[
                JoinPackage::of(&alice_second, &second_kp),
                JoinPackage::of(&bob, &bob_kp),
            ],
        )
        .unwrap();
    let mut channel = Conversation::create(&alice).unwrap();
    let bob_kp = bob.key_package().unwrap();
    channel
        .add_members(&alice, &[JoinPackage::of(&bob, &bob_kp)])
        .unwrap();
    let mut direct = Conversation::create(&alice).unwrap();
    let bob_kp = bob.key_package().unwrap();
    let change = direct
        .add_members(&alice, &[JoinPackage::of(&bob, &bob_kp)])
        .unwrap();
    let mut recipient = Conversation::join(&bob, &change.welcome).unwrap();
    let mut binding = RestrictedChannelBinding {
        parent_conversation_id: vec![4; 16],
        channel_conversation_id: vec![5; 16],
        recipient_device: bob_id.to_vec(),
        parent_epoch: parent.epoch(),
        channel_epoch: channel.epoch(),
        parent_members: parent.member_identities(),
        channel_members: channel.member_identities(),
        generation: 1,
        name: String::new(),
    };
    let ciphertext = direct.encrypt(&alice, &binding.encode_to_vec()).unwrap();
    let Received::Application { sender, data } = recipient.receive(&bob, &ciphertext).unwrap()
    else {
        panic!("application expected")
    };
    binding = RestrictedChannelBinding::decode(data.as_slice()).unwrap();
    let admins = vec![alice_id[..16].to_vec()];
    let context = BindingContext {
        parent_id: &[4; 16],
        channel_id: &[5; 16],
        parent: &parent,
        channel: &channel,
        authenticated_sender: &sender,
        recipient: &bob_id,
        admins: &admins,
        last_generation: 0,
    };
    assert!(!validate_binding(&binding, &context));
    let second_kp = alice_second.key_package().unwrap();
    channel
        .add_members(&alice, &[JoinPackage::of(&alice_second, &second_kp)])
        .unwrap();
    binding.channel_epoch = channel.epoch();
    binding.channel_members = channel.member_identities();
    let context = BindingContext {
        parent_id: &[4; 16],
        channel_id: &[5; 16],
        parent: &parent,
        channel: &channel,
        authenticated_sender: &sender,
        recipient: &bob_id,
        admins: &admins,
        last_generation: 0,
    };
    assert!(validate_binding(&binding, &context));
}

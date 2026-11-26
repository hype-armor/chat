//! Wire experiment only. No test here enables or proves channel authorization.
use chat_core::mls::{Conversation, Device, JoinPackage, Received};
use chat_proto::v1::RestrictedChannelBinding;
use prost::Message;

#[test]
fn encrypted_binding_is_private_and_mls_rejects_ciphertext_replay() {
    let alice_id = [1; 32];
    let bob_id = [2; 32];
    let outsider_id = [3; 32];
    let alice = Device::new(&alice_id).unwrap();
    let bob = Device::new(&bob_id).unwrap();
    let outsider = Device::new(&outsider_id).unwrap();
    let mut direct = Conversation::create(&alice).unwrap();
    let kp = bob.key_package().unwrap();
    let change = direct
        .add_members(
            &alice,
            &[JoinPackage {
                identity: &bob_id,
                key_package: &kp,
            }],
        )
        .unwrap();
    let mut recipient = Conversation::join(&bob, &change.welcome).unwrap();
    let mut unrelated = Conversation::create(&outsider).unwrap();
    let binding = RestrictedChannelBinding {
        parent_conversation_id: vec![4; 16],
        channel_conversation_id: vec![5; 16],
        recipient_device: bob_id.to_vec(),
        parent_epoch: 2,
        channel_epoch: 3,
        parent_members: vec![alice_id.to_vec(), bob_id.to_vec(), outsider_id.to_vec()],
        channel_members: vec![alice_id.to_vec(), bob_id.to_vec()],
        generation: 1,
        name: "private channel".into(),
    };
    let ciphertext = direct.encrypt(&alice, &binding.encode_to_vec()).unwrap();
    assert!(
        !ciphertext
            .windows(binding.name.len())
            .any(|w| w == binding.name.as_bytes())
    );
    assert!(unrelated.receive(&outsider, &ciphertext).is_err());
    let Received::Application { sender, data } = recipient.receive(&bob, &ciphertext).unwrap()
    else {
        panic!("expected application message");
    };
    assert_eq!(sender, alice_id);
    assert_eq!(
        RestrictedChannelBinding::decode(data.as_slice()).unwrap(),
        binding
    );
    assert!(recipient.receive(&bob, &ciphertext).is_err());
}

use chat_core::mls::{Conversation, Device, JoinPackage};
use chat_core::restricted_channel_binding::{BindingContext, validate_binding};
use chat_proto::v1::RestrictedChannelBinding;

#[test]
fn parent_removal_rejects_old_and_rewritten_claims() {
    let alice_id = [1; 32];
    let bob_id = [2; 32];
    let alice = Device::new(&alice_id).unwrap();
    let bob = Device::new(&bob_id).unwrap();
    let mut parent = Conversation::create(&alice).unwrap();
    let kp = bob.key_package().unwrap();
    parent
        .add_members(&alice, &[JoinPackage::of(&bob, &kp)])
        .unwrap();
    let mut channel = Conversation::create(&alice).unwrap();
    let kp = bob.key_package().unwrap();
    channel
        .add_members(&alice, &[JoinPackage::of(&bob, &kp)])
        .unwrap();
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
    parent.stage_remove_members(&alice, &[&bob_id]).unwrap();
    parent.merge_pending_commit(&alice).unwrap();
    let admins = vec![alice_id[..16].to_vec()];
    let ctx = BindingContext {
        parent_id: &[4; 16],
        channel_id: &[5; 16],
        parent: &parent,
        channel: &channel,
        authenticated_sender: &alice_id,
        recipient: &bob_id,
        admins: &admins,
        last_generation: 0,
    };
    assert!(!validate_binding(&binding, &ctx));
    binding.parent_epoch = parent.epoch();
    binding.parent_members = parent.member_identities();
    assert!(!validate_binding(&binding, &ctx));
}

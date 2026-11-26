//! MLS supplies the sender and rosters here. Conversation-ID associations,
//! admin state and replay fences are test-supplied, not integrated proof.
use chat_core::mls::{Conversation, Device, JoinPackage, Received};
use chat_core::restricted_channel_binding::{BindingContext, validate_binding};
use chat_proto::v1::RestrictedChannelBinding;
use prost::Message;

#[test]
fn authentic_mls_sender_and_current_rosters_are_checked() {
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
    let mut direct = Conversation::create(&alice).unwrap();
    let kp = bob.key_package().unwrap();
    let change = direct
        .add_members(&alice, &[JoinPackage::of(&bob, &kp)])
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
    let mut ctx = BindingContext {
        parent_id: &[4; 16],
        channel_id: &[5; 16],
        parent: &parent,
        channel: &channel,
        authenticated_sender: &sender,
        recipient: &bob_id,
        admins: &admins,
        last_generation: 0,
    };
    assert!(validate_binding(&binding, &ctx));
    ctx.last_generation = 1;
    assert!(!validate_binding(&binding, &ctx));
    ctx.last_generation = 0;
    let mut forged = binding.clone();
    forged.parent_conversation_id = vec![7; 16];
    assert!(!validate_binding(&forged, &ctx));
    forged = binding.clone();
    forged.channel_conversation_id = vec![7; 16];
    assert!(!validate_binding(&forged, &ctx));
    forged = binding.clone();
    forged.parent_epoch += 1;
    assert!(!validate_binding(&forged, &ctx));
    forged = binding.clone();
    forged.channel_epoch += 1;
    assert!(!validate_binding(&forged, &ctx));
    forged = binding.clone();
    forged.parent_members.pop();
    assert!(!validate_binding(&forged, &ctx));
    forged = binding.clone();
    forged.channel_members.push(vec![8; 32]);
    assert!(!validate_binding(&forged, &ctx));
    forged = binding.clone();
    forged.recipient_device = vec![8; 32];
    assert!(!validate_binding(&forged, &ctx));
    ctx.authenticated_sender = &bob_id;
    assert!(!validate_binding(&binding, &ctx));
    ctx.authenticated_sender = &sender;
    ctx.channel = &parent;
    assert!(!validate_binding(&binding, &ctx));
    assert!(recipient.receive(&bob, &ciphertext).is_err());
}

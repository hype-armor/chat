//! Isolated MLS integration. This does not provide production delivery or persistence.
use chat_core::mls::{Conversation, Device, JoinPackage, Received};
use chat_core::presence::binding::{Binding, Context, ReplacementFence, accept_replacement};

#[test]
fn binding_is_checked_against_authenticated_sender_and_joined_group() {
    let alice_id = [1; 32];
    let bob_id = [2; 32];
    let alice = Device::new(&alice_id).unwrap();
    let bob = Device::new(&bob_id).unwrap();
    let mut direct_a = Conversation::create(&alice).unwrap();
    let key = bob.key_package().unwrap();
    let welcome = direct_a
        .add_members(&alice, &[JoinPackage::of(&bob, &key)])
        .unwrap();
    let mut direct_b = Conversation::join(&bob, &welcome.welcome).unwrap();
    let mut presence_a = Conversation::create(&alice).unwrap();
    let key = bob.key_package().unwrap();
    let welcome = presence_a
        .add_members(&alice, &[JoinPackage::of(&bob, &key)])
        .unwrap();
    let presence_b = Conversation::join(&bob, &welcome.welcome).unwrap();
    let direct = direct_a.id();
    let group = presence_b.id();
    let roster = presence_b.member_identities();
    let binding = Binding {
        direct_conversation: direct.clone(),
        presence_conversation: group.clone(),
        recipient_account: bob_id[..16].to_vec(),
        consent_generation: 1,
        replacement_generation: 1,
        members: roster.clone(),
    };
    let ciphertext = direct_a
        .encrypt(&alice, &postcard::to_allocvec(&binding).unwrap())
        .unwrap();
    let Received::Application { sender, data } = direct_b.receive(&bob, &ciphertext).unwrap()
    else {
        panic!("expected application")
    };
    let decoded: Binding = postcard::from_bytes(&data).unwrap();
    let context = Context {
        sender: &sender,
        sender_account: &alice_id[..16],
        recipient_account: &bob_id[..16],
        recipient_device: &bob_id,
        direct_conversation: &direct,
        consent_generation: Some(1),
        authorized_members: &roster,
        group_members: &roster,
        group_id: &group,
    };
    let fence = accept_replacement(&decoded, &context, &ReplacementFence::default()).unwrap();
    assert!(accept_replacement(&decoded, &context, &fence).is_none());
    assert!(direct_b.receive(&bob, &ciphertext).is_err());
}

use chat_core::presence::binding::{Binding, Context, ReplacementFence, accept_replacement};

#[test]
fn replacements_require_exact_authorized_roster_and_a_live_grant() {
    let alice = vec![1; 32];
    let bob = vec![2; 32];
    let members = vec![alice.clone(), bob.clone()];
    let direct = vec![3; 16];
    let group = vec![4; 16];
    let binding = Binding {
        direct_conversation: direct.clone(),
        presence_conversation: group.clone(),
        recipient_account: bob[..16].to_vec(),
        consent_generation: 7,
        replacement_generation: 1,
        members: members.clone(),
    };
    let mut context = Context {
        sender: &alice,
        sender_account: &alice[..16],
        recipient_account: &bob[..16],
        recipient_device: &bob,
        direct_conversation: &direct,
        consent_generation: Some(7),
        authorized_members: &members,
        group_members: &members,
        group_id: &group,
    };
    let empty = ReplacementFence::default();
    let fence = accept_replacement(&binding, &context, &empty).unwrap();
    assert!(accept_replacement(&binding, &context, &fence).is_none());
    let mut stale = binding.clone();
    stale.replacement_generation = 2;
    assert!(accept_replacement(&stale, &context, &fence).is_none()); // group reuse
    context.consent_generation = None;
    assert!(accept_replacement(&binding, &context, &empty).is_none());
    context.consent_generation = Some(8);
    assert!(accept_replacement(&binding, &context, &empty).is_none());
    context.consent_generation = Some(7);
    let wrong = vec![9; 16];
    context.recipient_account = &wrong;
    assert!(accept_replacement(&binding, &context, &empty).is_none());
    context.recipient_account = &bob[..16];
    let mut other_bob = bob.clone();
    other_bob[31] = 3;
    let changed = vec![alice.clone(), other_bob];
    context.authorized_members = &changed;
    assert!(accept_replacement(&binding, &context, &empty).is_none());
    context.authorized_members = &members;
    context.group_members = &changed;
    assert!(accept_replacement(&binding, &context, &empty).is_none());
    context.group_members = &members;
    let mut wrong_sender = alice.clone();
    wrong_sender[31] = 9;
    context.sender = &wrong_sender;
    assert!(accept_replacement(&binding, &context, &empty).is_none());
}

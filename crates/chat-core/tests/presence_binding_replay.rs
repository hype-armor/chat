use chat_core::presence::binding::{Binding, Context, ReplacementFence, accept_replacement};

#[test]
fn restored_fence_rejects_older_group_reuse_and_revoked_grants() {
    let alice = vec![1; 32];
    let bob = vec![2; 32];
    let members = vec![alice.clone(), bob.clone()];
    let direct = vec![3; 16];
    let first = vec![4; 16];
    let second = vec![5; 16];
    let mut binding = Binding {
        direct_conversation: direct.clone(),
        presence_conversation: first.clone(),
        recipient_account: bob[..16].to_vec(),
        consent_generation: 1,
        replacement_generation: 1,
        members: members.clone(),
    };
    let mut context = Context {
        sender: &alice,
        sender_account: &alice[..16],
        recipient_account: &bob[..16],
        recipient_device: &bob,
        direct_conversation: &direct,
        consent_generation: Some(1),
        authorized_members: &members,
        group_members: &members,
        group_id: &first,
    };
    let fence = accept_replacement(&binding, &context, &ReplacementFence::default()).unwrap();
    binding.presence_conversation = second.clone();
    binding.replacement_generation = 2;
    context.group_id = &second;
    let fence = accept_replacement(&binding, &context, &fence).unwrap();
    let serialized = postcard::to_allocvec(&fence).unwrap();
    let restored: ReplacementFence = postcard::from_bytes(&serialized).unwrap();
    binding.presence_conversation = first.clone();
    binding.replacement_generation = 3;
    context.group_id = &first;
    assert!(accept_replacement(&binding, &context, &restored).is_none());
    context.group_id = &second;
    binding.presence_conversation = second.clone();
    context.consent_generation = None;
    assert!(accept_replacement(&binding, &context, &restored).is_none());
    let mut incomplete = restored;
    incomplete.used_group_ids.clear();
    context.consent_generation = Some(1);
    assert!(accept_replacement(&binding, &context, &incomplete).is_none());
}

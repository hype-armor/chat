use chat_core::mls::{Conversation, Device, JoinPackage, Received};
use chat_core::restricted_channel_binding::history::History;

#[test]
fn authenticated_rosters_preserve_old_audience_and_replay_fence() {
    let a = [1; 32];
    let b = [2; 32];
    let e = [3; 32];
    let alice = Device::new(&a).unwrap();
    let bob = Device::new(&b).unwrap();
    let eve = Device::new(&e).unwrap();
    let mut direct = Conversation::create(&alice).unwrap();
    let bk = bob.key_package().unwrap();
    let ek = eve.key_package().unwrap();
    let change = direct
        .add_members(
            &alice,
            &[JoinPackage::of(&bob, &bk), JoinPackage::of(&eve, &ek)],
        )
        .unwrap();
    let mut receiver = Conversation::join(&bob, &change.welcome).unwrap();
    let old_epoch = direct.epoch();
    let old_roster = direct.member_identities();
    let old_message = direct.encrypt(&alice, b"binding").unwrap();
    let commit = direct.stage_remove_members(&alice, &[&e]).unwrap();
    direct.merge_pending_commit(&alice).unwrap();
    assert!(matches!(
        receiver.receive(&bob, &commit).unwrap(),
        Received::EpochChanged(_)
    ));
    assert!(matches!(
        receiver.receive(&bob, &old_message).unwrap(),
        Received::Application { .. }
    ));
    let p = [4; 16];
    let c = [5; 16];
    let d = [6; 16];
    let mut h = History::bootstrap(
        &p,
        &c,
        &d,
        0,
        vec![a.to_vec(), b.to_vec()],
        vec![a[..16].to_vec()],
        old_epoch,
        old_roster,
    )
    .unwrap();
    assert!(h.record_direct(direct.epoch(), direct.member_identities()));
    assert!(!h.accept(&p, &c, &d, 0, old_epoch, &a, &b, 1));
    assert!(!h.accept(&p, &c, &d, 0, direct.epoch() + 1, &a, &b, 1));
    let (before, old_anchor) = h.snapshot().unwrap();
    assert!(h.accept(&p, &c, &d, 0, direct.epoch(), &a, &b, 1));
    let (bytes, anchor) = h.snapshot().unwrap();
    assert!(History::restore(&before, &anchor).is_none());
    assert!(History::restore(&[], &old_anchor).is_none());
    let mut restored = History::restore(&bytes, &anchor).unwrap();
    assert!(!restored.accept(&p, &c, &d, 0, direct.epoch(), &a, &b, 1));
    assert!(restored.accept(&p, &c, &d, 0, direct.epoch(), &a, &b, 2));
}

#[test]
fn parent_multi_device_transition_requires_contiguous_authenticated_history() {
    let a = [1; 32];
    let b = [2; 32];
    let mut second = a;
    second[31] = 9;
    let alice = Device::new(&a).unwrap();
    let bob = Device::new(&b).unwrap();
    let other = Device::new(&second).unwrap();
    let mut parent = Conversation::create(&alice).unwrap();
    let bk = bob.key_package().unwrap();
    parent
        .add_members(&alice, &[JoinPackage::of(&bob, &bk)])
        .unwrap();
    let p = [4; 16];
    let c = [5; 16];
    let d = [6; 16];
    let mut h = History::bootstrap(
        &p,
        &c,
        &d,
        parent.epoch(),
        parent.member_identities(),
        vec![a[..16].to_vec()],
        0,
        vec![a.to_vec(), b.to_vec()],
    )
    .unwrap();
    let old = parent.epoch();
    let kp = other.key_package().unwrap();
    parent
        .add_members(&alice, &[JoinPackage::of(&other, &kp)])
        .unwrap();
    assert!(!h.record_parent(
        parent.epoch() + 1,
        parent.member_identities(),
        vec![a[..16].to_vec()]
    ));
    assert!(h.record_parent(
        parent.epoch(),
        parent.member_identities(),
        vec![a[..16].to_vec()]
    ));
    assert!(!h.accept(&p, &c, &d, old, 0, &a, &b, 1));
    assert!(h.accept(&p, &c, &d, parent.epoch(), 0, &a, &b, 1));
}

# Experimental presence: MLS ratchet blocker

Presence must stay disabled. The latest-only lease store can lose ordinary
messages because the experimental presence primitive uses the same MLS sender
ratchet as ordinary conversation messages. This is separate from authorization,
privacy, and other activation blockers.

## Reproduction

Run `cargo test -p chat-core presence::ratchet_tests -- --nocapture`. These
native tests use real OpenMLS clients, one sender, two recipient devices, and
snapshot restore. They model lease overwrites by retaining only the newest
presence ciphertext; they do not run the HTTP store.

With the current OpenMLS 0.8.3 defaults, the forward distance is 1000 and the
out-of-order tolerance is 5. The tests establish these observations in one
unchanged epoch:

- If a recipient starts at generation 0, generation 1000 decrypts. Generation
  1001 fails. After that failure and restore, a later ordinary message also
  fails on that recipient. A second device that received generation 1000 can
  receive that ordinary message.
- Send an ordinary message, then 6 presence messages. If a device receives
  only the latest presence first, the delayed ordinary message fails, including
  after restore. Another device that receives the ordinary message first can
  receive the latest presence. A subsequent ordinary message still decrypts.
- One presence message and one ordinary message decrypt in either order, also
  across restore. This does not establish safety for arbitrary delay or loss.

These are message-generation limits, not time limits. Long gaps need not contain
any ordinary messages. A server or network delay can also reorder a durable
message behind presence updates. More frequent polling does not provide a
reliable ordering guarantee, especially across devices, restarts, or missed
polls. Increasing the limits only moves the failure threshold and changes key
retention and resource costs; it is not a complete fix.

## Safe directions for design review

Keep the feature off until a reviewed design isolates ephemeral presence from
the durable conversation ratchet, or otherwise guarantees reliable, ordered
consumption without putting presence into history, backup, or the durable
message queue. A separate, independently managed MLS context is one possible
direction, but its membership, authorization, recovery, key lifecycle, and
metadata need a complete design and independent review. Do not implement new
cryptography or treat these tests as approval to enable presence.

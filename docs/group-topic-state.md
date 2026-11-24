# Encrypted group topic state: implementation foundation

This document specifies a candidate client-side topic rule for ADR-0051. The
pure rules in `web/src/core/groupTopic.ts` include snapshot merging and safe
clock advancement, but are not connected to storage, snapshot delivery, or the
user interface. They do not provide a working group topic feature. Integration and independent security review remain necessary. The WASM
bindings can encode an MLS-encrypted topic and expose valid decrypted topic events
with their authenticated MLS sender. The worker discards these events without
applying state, and does not enable sending. The core codec does not validate
the topic rules; consumers must validate them before use.

Older clients ignore the unknown body. They must still persist the advanced MLS
ratchet after decryption, or later messages can fail. They do not display or
apply topic updates. `engine-group-topic-mls.test.ts` checks that the worker
consumes and discards topic state. If the storage batch fails, the worker
closes the socket without acknowledging the event and blocks retry in the same
engine. A fresh engine can replay the ciphertext from the last saved ratchet,
acknowledge it after persistence, and decrypt a later message. These tests do
not exercise an older client or prove crash safety across all storage failure
points. Do not enable
sending until client compatibility, state recovery, and the remaining
integration have been reviewed.

## Updates

A topic update is an MLS-encrypted group application message. Its body contains
`text` and a positive safe-integer Lamport `clock`. Empty text clears the topic.
The UTF-8 encoding of text is limited to 512 bytes. An author chooses one more
than the highest accepted clock in that group. A client must refuse to create an
update if that increment would exceed `Number.MAX_SAFE_INTEGER`.

Any authenticated group member at the message's MLS epoch may author an
update. This is advisory group behavior, not moderation. The receiver must derive
account and device from the authenticated MLS sender, verify membership at the
message epoch, and bind the update to that group. It must not trust identities
in the body or unauthenticated envelope. The pure reducer assumes the caller
has performed those checks; it performs no authentication itself.

Updates compare by clock, then authenticated account ID, authenticated device ID,
and text, in ascending JavaScript string order. The maximum wins. The final text
comparison gives deterministic results even if a device equivocates at one
clock. A clear is an ordinary update, not an absence of state. Persist its
clock and identity so old messages cannot restore a cleared topic. Different
arrival orders converge if participants receive the same valid updates. A member
can choose an extreme clock and prevent later edits; this design does not defend
against malicious members. Epoch changes do not reset the clock.

## New members and snapshots

New members do not receive old history by default. The intended snapshot is an
MLS-encrypted current-state attestation sent by an existing current member to
the group after the newcomer joins. It must carry the winning update's text,
clock, and original account/device ordering values, including a cleared topic.
The authenticated sender attests to those values; forwarding is not proof of
original authorship. A newcomer must not treat the snapshot as an independently
verified original update or as moderation evidence. Snapshots must merge by the
same ordering and must not replace a newer local state. The pure snapshot
reducer implements this merge only; its caller must authenticate the attester
and validate current membership and group binding. A malicious member can
lie about the state, including its ordering values. Offline members and lost
snapshots can leave newcomers without a topic; the UI must show unknown, not
claim an empty topic. Snapshot request, delivery, retry, membership races,
persistence, and rollback protection are not implemented or security reviewed.
They must be resolved before enabling this feature.

No topic content, topic-specific type flag, author, clock, or snapshot metadata
may be sent in plaintext to the server. Use the existing encrypted message
transport without adding server-visible topic metadata. This foundation adds no
channel membership, server policy, or stronger moderation.

# Encrypted group topics: opt-in sending

ADR-0051 permits an experimental send and receive path for accepted private
chat groups. An isolated web build can opt in with
`VITE_EXPERIMENTAL_GROUP_TOPICS=true`. The default build does not send, apply,
or display topics. An opted-in worker queues a normal MLS-encrypted envelope,
with no push notification. It persists the MLS ratchet, outbox and accepted
edit in the same encrypted storage batch before it sends the update. A sender
only displays the edit as the current topic after relay acceptance and a
second durable write. The editor reports local queue acceptance, not
delivery to every member. An observed membership or epoch change can invalidate a queued edit.
The worker does not retry queued topics on a different socket. Before it enables
posting on a new socket, it waits for a Pong after the relay's initial backlog
and for the preceding deliveries to finish storage. A failed initial backlog
read closes the relay session. This barrier does not enforce the exact relay
roster during later concurrent membership changes. Test with the matching relay;
older relays could answer Ping after a failed initial backlog read.

A recipient must opt in too. The worker verifies the authenticated MLS sender
against its current device membership. A message from a retained epoch can
apply only while that exact device is still a current member. No sender or
epoch from outer metadata grants authority. Topic state is device-local; a
new device or new member can have an unknown topic until another edit arrives.
The experiment requires at least 3 distinct accounts in the authenticated MLS
roster. The normal group UI also accepts 2-account groups; the topic editor
cannot use that UI classification to distinguish them from direct chats. The
first topic slice applies to parent groups, not their restricted channels.
Editing requires an online connection. Only 1 topic per group can wait in the
outbox, and each device can author at most 32 updates per observed epoch. This
bounds the skipped MLS generations if queued updates are canceled.

The current snapshot protocol described below is not implemented. Do not
enable this experiment by default or deploy it as a complete group feature.

CI runs the real-relay browser check in a separate opt-in build. To repeat it
from `web` with a disposable `DATABASE_URL`, run:

```sh
VITE_EXPERIMENTAL_GROUP_TOPICS=true pnpm exec vite build --outDir dist-group-topics
E2E_SERVER=1 E2E_GROUP_TOPICS=1 pnpm exec playwright test e2e/group-topic-send.spec.ts
```

The test uses 3 accounts. It checks sending, reload, clearing and the absence
of topic events in normal chat history.

Older clients ignore the unknown body. They must still persist the advanced MLS
ratchet after decryption, or later messages can fail. They do not display or
apply topic updates. `engine-group-topic-mls.test.ts` checks that a worker with
the feature disabled consumes and discards topic state. If the storage batch fails, the worker
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

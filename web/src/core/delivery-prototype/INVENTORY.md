# Acceptance prototype: scope and gaps

This is not connected to Engine. It is not a production transaction or recovery system.
`journal-idb.ts` stores plaintext test data. It must not hold real application data.
The prototype stores one complete staged app value with the MLS snapshot, replay IDs,
and pending publications in one compare-and-replace transaction. The caller must
supply pure staging, encrypted storage, lifecycle checks, and a cross-instance lock
that also covers transport. A callback or lock is not enforced by the type system.
Pending publication after a crash or error requires manual recovery. No publication
is assumed safe to replay. No recovery interface is implemented. The fixed replay
ledger fails closed at capacity; no IDs are evicted. A delivery that cannot decrypt,
including an envelope that requires a future epoch, is fenced rather than acknowledged.
A duplicate ID with different bytes is rejected. Distinct IDs are not authenticated
content identities and are not deduplicated against each other.

## Engine operations not staged by this prototype

The following inventory refers to the current `engine.ts`, including helper calls.
It is not a claim that a generic `app` value already models these operations.

- `process` mutates the live MLS core and catches errors from both `receive` and
  `apply`. The socket path records `recent`, persists, sends a socket ACK only if
  the socket is current, then starts departure commits and outbox flushing. Early
  envelopes are queued with a bounded eviction and recursively processed on join.
- `persist` writes `me-deletion-inbox:<account>` separately and batches `core` and
  `app`. `SecureStore` encrypts values before IndexedDB writes. This prototype
  neither seals records nor transacts with the real store, file store, or keys.
- Join and epoch paths change conversations, peers, synced metadata, locality,
  live sessions and departure state. They observe keys, which can append notices;
  they invalidate drafts and update live-message histories. They queue profiles,
  schedule sync, replenish key packages, refresh call keys, and emit UI events.
  Proposal handling can mutate MLS again and queue an outbound leave envelope.
- Ordinary messages update unread counts, names and avatars, history under
  `messages:<conversation>`, typing leases, receipt queues and views. They can
  schedule locality lookup and attachment download. Location area preparation,
  draft and history operations have their own lifecycle and deletion fences.
- Reactions read and write history and enforce target/hash/tombstone rules.
  Receipts update stored message statuses. `queueReceipt` batches work for later
  encrypted transport. None of these actual implementations is staged here.
- Deletions update `deletions:<account>`, histories, hidden-send capsules and
  indexes, and may delete attachment blobs or parts. Their tombstone, cleanup,
  suppression and retry semantics require an explicit atomic design across stores.
- Device sync may write `account`, update account state and deletion inputs, or
  queue pending sync and start directory requests. Calls can write notices and
  emit call signals. Live messages update histories and schedule locality work.
  Typing publishes ephemeral leases and schedules expiry. These operations need
  separate replay and lifecycle policies; they are not safe generic callbacks.
- Post-acceptance network work includes ACK, receipts, profile/device sync, key
  package replenishment, queued sends, departure commits and attachment downloads.
  The journal does not prove their remote idempotency or exclude another worker.

Before integration, design encrypted multi-record atomic storage and initialization,
lock ownership and sign-out fencing across workers, versioned migration and capacity
recovery, event-specific staging, and explicit publication/recovery policies.
Audit every helper and nested asynchronous callback against those boundaries.

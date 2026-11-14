# `chat-bot`

Native JSON-lines worker for encrypted scheduled bots. It does not call an AI provider.
The parent owns consent, inference, and disclosure policy.

## State and safety limits

`CHAT_BOT_STATE_KEY` must be standard-base64 for 32 random bytes. The worker seals its
accounts, private MLS snapshots, event journal, and outbox with AES-256-GCM. It uses
random nonces, atomic private-mode writes, and an exclusive state-directory lock. The
state directory must be private. A state file binds saved identities to one server URL.

The worker caps the outbox and event journal at 4096 operations, unacknowledged events
at 256, and dedup records at 65536 per bot. It does not evict pending operations or
unacknowledged events. A full event queue stops the worker before it processes or
acknowledges another delivery. A full dedup journal stops the worker. An operator must
preserve the encrypted state, reconcile pending sends and events, then plan a safe state
rollover. Do not delete state to clear a limit. Pending welcomes and sends are never
replayed automatically. The parent must retry with the same operation ID after consent
and membership checks.

A proposal or device change blocks the affected MLS membership. An accepted MLS commit
can clear a proposal block. A device-change block can require an operator to reconcile
the group. This crate does not create membership commits or resolve proposals. Preserve
the encrypted state until reconciliation. HTTP rate-limit responses stop the current
bootstrap operation. The worker does not change server limits.

On connect, the worker sends an application ping. It reports `connected` only after the
server returns the pong that follows its initial delivery backlog. It persists each
visible event before stdout and waits for `ackEvent` before it acknowledges that delivery.

## Verification

`cargo test -p chat-bot` includes native state tests and MLS group tests for 2, 3, 10,
and 50 members, plus a join at epoch 2 and snapshot restores. The tests use in-process
MLS clients. They do not test a live server or a WebSocket server implementation.

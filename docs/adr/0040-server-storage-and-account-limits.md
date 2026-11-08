# ADR-0040: Server storage quotas and account message limits

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** Greg; implementation team
- **Related requirements:** FR-SAF-2, NFR-LEG-5

## Context

Operators need shared server storage caps, individual account quotas, and message limits that linked devices and replicas cannot bypass.
The existing attachment cap uses separate usage queries and inserts. Concurrent requests can exceed it.
Pending multipart uploads and backups also consume object storage.
Per-device message token buckets alone permit accounts to multiply their allowance through linked devices and server replicas.
Users need a private view of their own quota usage.

## Options considered

1. **Query stored attachment rows before accepting uploads.** Simple, but races and pending uploads bypass the check.
2. **Reserve ciphertext bytes in PostgreSQL before object-store writes.** Shared, concurrency-safe enforcement, with conservative crash recovery.
3. **Expose public administrator endpoints.** Convenient, but requires a separate authentication and authorization design.
4. **Use a local operator command with database credentials.** Avoids an additional privileged network API.

## Decision

Use a durable object ledger and centrally stored policies. Lock the singleton policy row while checking and reserving capacity.
Count every reservation against server and account budgets before writing any ciphertext.
Count attachments, full multipart reservations, and encrypted backups. Reserve replacement backups before deleting old objects.
Do not charge multipart completion twice. Release capacity only after confirmed deletion or an object-store NotFound response.
Preserve global charges after account deletion. Never automatically release an abandoned reservation when a writer can still publish its object.

An absent account override inherits the default. A null quota means unlimited. A zero quota blocks new allocation.
Lowering a quota preserves existing data and does not disable reads, acknowledgements, or deletion.
The initial account default is 2 GiB. The server cap starts unlimited and operators must configure it for their storage capacity.
These are ciphertext object-store quotas, not physical disk quotas. Database queues, WAL, map areas, infrastructure backups, and storage overhead need separate capacity budgets.

Use persistent per-account, per-minute message counters in the authorized send transaction, in addition to the existing device token bucket.
Account overrides can tighten or raise the configured default. Zero blocks sends. A missing override inherits the server default.
Keep existing upload bandwidth, registration, lookup, first-contact, report, TURN, and queue protections.

Provide `chat-admin` for policy changes and usage inspection. It uses operator database credentials and is not a public HTTP service.
Provide authenticated `GET /v1/storage` for the caller's account only. Fetch it in the core worker and show usage in account settings.
No message content, encryption keys, filenames, or other users' usage enters quota responses.

## Consequences

Concurrent uploads and linked devices share one budget across replicas.
Reservations survive crashes. Failures can conservatively retain capacity until an operator fences writers and reconciles the ledger.
Objects orphaned before the migration need a storage inventory. SQL cannot discover objects absent from the existing database.
The ledger can retain objects after account deletion, without retaining the deleted account's identity.
This implementation does not claim exact physical disk accounting or automated recovery of every abandoned object.

The singleton reservation lock serializes allocation transactions, but not network streaming.
Usage queries aggregate the ledger. Large installations can later add transactional counters without changing policy semantics.
Fixed message windows can permit a burst across a minute boundary. The existing per-device token bucket remains an additional burst control.

## Validation

Test concurrent reservations, server and account caps, individual overrides, pending uploads, backup replacement, and release after deletion.
Test private usage responses and user-facing finite, unlimited, near-limit, loading, and error states.
Test shared message budgets across linked devices and replicas, authorization failures, and rollback of failed sends.
Test operator argument validation and policy updates against an isolated PostgreSQL database.

# ADR-0042: Encrypted message deletion

- **Status:** Accepted for implementation
- **Date:** 2026-11-08
- **Deciders:** Greg, implementation agents
- **Related requirements:** FR-MSG-7, FR-MSG-13, NFR-SEC-1, NFR-SEC-5
- **Builds on:** ADR-0022, ADR-0038, ADR-0039, ADR-0041

## Context

Greg selected both deletion scopes, deletion across his linked devices for Me,
and a 1-hour window for everyone deletion.
The server must not learn deletion targets or gain message plaintext.
Deletion must not bypass authenticated original bindings or restore erased content
through replay, delayed media work, retries, history reload, or backup merging.

## Decision

### Scopes and user promises

`me` removes a message from the account's history across its linked devices,
using encrypted own-device synchronization. Local acceptance happens first;
other linked devices apply the suppression when synchronization reaches them.
It does not alter another account's copy and has no time limit.

A message without a stored verifiable original hash can only be removed on this
device. This includes legacy records and not-yet-encrypted pending originals.
The confirmation must identify that fallback rather than promise remote removal.
Me deletion does not recall a queued outgoing message; another account can still
receive it. This limitation must be clear for pending sends.

`everyone` sends an ordinary encrypted MLS deletion request for an original
owned by the authenticated local account. Other current devices can honor it.
Only verified user-visible originals qualify; notices and legacy originals with
missing hashes do not. Own devices can delete another device's original from the
same account. Group administration does not grant deletion rights over others.
Blocking or a pending message request does not revoke this narrow deletion right.
Valid incoming deletion requests still require authenticated current membership
and exact original ownership; do not reuse reaction display guards that would
ignore them solely because the author is blocked or the chat is unaccepted.

Everyone deletion redacts the local original after durable acceptance, even if
transport later fails. Show a deleted placeholder and truthful sending/failure
status with explicit retry. Do not imply remote erasure from local acceptance.

Neither scope guarantees erasure from screenshots, exports, old backups, older
clients, uncooperative recipients, or browser storage snapshots. The current
backup preserves known tombstones, but an older backup can lack later requests.

### One-hour predicate

Use the authenticated original `Content.sent_at_ms` and deletion request
`Content.sent_at_ms`, not the outer envelope timestamp or a UI-supplied value.
Both timestamps must be positive JavaScript-safe integers. A request qualifies
when `0 <= requestTime - originalTime <= 3_600_000`.

For a new local everyone request, use nondecreasing session time. Reject an
original more than 2 seconds in the future and reject a request past the boundary.
A tolerable future original can use `max(now, originalTime)` as request time.
A wall-clock rollback must not extend eligibility during the session. The worker
rechecks eligibility when confirming, not only when advertising the action.
The UI must expire an open menu/dialog capability at the boundary plus 1 ms.

Persist the first durably accepted request time and immutable target binding.
Explicit retries repeat that accepted intent and retain its request time, even
when re-encryption occurs after the hour or on a replacement own device.
A new post-deadline intent is not a retry. A receiver validates the signed time
difference, not delivery time; a timely request can arrive while a device was
offline. Reject newly received requests more than 2 seconds in the future.

Author-controlled clocks cannot prove trusted elapsed time. This is an honest
client policy, not a server-attested hour. It never grants authority over another
account's original. No server-visible timing/target field or new crypto is added.

### Encrypted protocol and binding

Add `Content.deletion`, body tag 15, with `Deletion.target` (16 bytes),
`target_hash` (32 bytes), and `target_author` (16-byte account).
The authenticated MLS sender account must equal `target_author`.
The worker resolves the original in the same conversation and verifies its
stored hash, authenticated author account, and authenticated original timestamp.
Use the unchanged ADR-0038 content-hash primitive. Never reconstruct a trusted
hash from normalized history, a preview, or UI fields.

Expose `sendDeletion(conversationId, target, targetHash, targetAuthor, sentAtMs,
messageId)` in WASM. Validate widths, time, and local author-account equality.
Expose deletion binding fields on the received event, with the normal
conversation, authenticated sender, and signed timestamp. Invalid bodies have no
projection effect. Unknown bodies still advance and persist the MLS ratchet.
Older readers ignore tag 15 and must decrypt the next ordinary message.

### Tombstones and early candidates

Everyone tombstones bind conversation, original author, and authentic content
hash. Retain the selected identifier as routing evidence, not sole authority.
Renaming an outer identifier must not restore identical authenticated content.
The content hash includes the signed original timestamp and sender device.
Identical authenticated content copies are treated as the same original.

Unknown-original requests can remain bounded, encrypted candidates. They cannot
remove or hide anything until a matching authentic original confirms the hash,
author, and timestamp predicate. Invalid candidates cannot poison a later valid
candidate. Deduplicate exact semantic requests, not untrusted envelope ids.
Bound unknown candidates separately: at most 256 per conversation and 2048 per
account, with a 4 MiB aggregate serialized-byte cap. Eviction can discard only
unverified candidates and can reduce availability, never authorize deletion.

Verified tombstones are irreversible, idempotent, and merge by set union.
Retain them while history or replay remains possible. Do not silently evict them
to satisfy storage capacity. If durable acceptance has no capacity, reject the
new local operation without removing readable content. Verified original binding
evidence must survive content removal so retry does not need a synthetic hash.

A Me tombstone uses a verified hash/author when available. An unverified local
record can use its local identifier only. Do not send identifier-only suppression
to another device or claim protection against server-renamed legacy copies.

### Own-device Me synchronization

Extend the existing encrypted `DeviceSync.state` JSON with a validated whitelist
of Me suppression bindings: conversation, authentic content hash, original author,
and an optional identifier hint. Authenticate the sender as a current own device
in the private self conversation. Recheck its membership and require every
recipient in that conversation to belong to this account before sending.
A normal conversation, another account, or a revoked own device cannot import
these records. No server API or plaintext synchronization field is added.

These records express the authenticated account's authority over its own history.
A receiving own device can retain a hash-bound Me suppression without having the
original yet. Apply it only to content with the matching authentic hash and author
in the matching conversation. It does not establish Everyone eligibility, prove
an original timestamp, or create a local Everyone retry intent. Never import a
`verified`, Everyone scope, local-intent, or delivery-status flag from JSON.

Merge Me records by irreversible set union. Duplicate records must not trigger an
echo loop. Own-account suppression records are durable tombstones, not bounded
unverified Everyone candidates; do not evict them because a new device lacks
history. Preserve them in encrypted backup and future own-device bootstrap.

Chunk synchronization below the existing encrypted-content limits. Preserve
retryable dirty intent through offline periods, restart, missing self groups,
and transport failure. Future link/device synchronization must include the whole
known Me suppression set, not only changes created during the current session.
Report synchronization failure through existing error/alert mechanisms rather
than silently losing it. Local acceptance is not confirmation of remote removal.

A native-authenticated own sender can precede a fresh device-directory result.
Keep such deferred Me input in an encrypted retry journal before persisting its
consumed MLS ratchet or acknowledging delivery. Do not apply it until fresh
own-device and private-self checks succeed. Reload must retain and revalidate
that input; an in-memory pending queue does not satisfy this requirement.

### Durable acceptance, transport, and recovery

Persist the tombstone before removing content or reporting local acceptance.
For a local everyone operation, that same first durable record must contain its
immutable accepted intent: binding, authenticated original time, request time,
and local-intent marker. A crash must not erase the only evidence needed for an
after-deadline retry. Do not infer local intent from an incoming own-device event.

Before that commit, failure leaves the original readable. After that commit,
cleanup failure must not expose the original; keep cleanup retryable.
Apply tombstones before history, previews, search, or backup expose content.
Recovery must reconcile an accepted own intent with its durable outbox/delivery
record. Missing evidence of a queued or accepted request means delivery is
unconfirmed and retryable, not indefinitely sending. A lost acknowledgement can
mean the request was delivered; UI failure copy must not assert the opposite.

For everyone requests, reuse the reaction acceptance/ratchet/outbox discipline.
Gate transport until the tombstone/history, advanced ratchet, and app/outbox
state are durable. Rejected envelopes must not become eligible through later
flushes, reload, or cleanup failure. Never roll back an advanced MLS ratchet.
If a tombstone was accepted but request acceptance fails, return local acceptance
and expose failed delivery, not an ambiguous RPC rejection.

Capture account and lifecycle epoch before queued work. Recheck them, core
identity, deletion state, and target evidence under the mutation lock after
asynchronous reads and acceptance writes. Keep the socket/session fences.
A stale send, retry, media result, or account response must not recreate content.
Everyone deletion cancels queued original sends where possible; an in-flight
original can already have reached recipients. A later acknowledgement must not
restore it. Me deletion does not recall a queued message.

An already accepted pending attachment can still require preparation fields.
Retain only its necessary worker-only transport capsule, encrypted separately
from readable history. Exclude capsules from UI, previews, search, downloads,
and backup. A tombstone must prevent upload/settlement callbacks from restoring
a visible row. Clean the capsule after settlement, cancellation, permanent
failure, or account reset. Do not keep an ordinary readable original as a capsule.
This narrow transport exception must not grow into a hidden history archive.
Register each capsule durably before writing its body. Reconcile this registry
on startup and transport completion, including a crash before tombstone commit.
Retain registration until physical record removal succeeds. A failed rollback
must not leave an undiscoverable capsule. Use the storage deletion operation,
not JSON serialization of `undefined`.

Pending and failed deletion records survive reload and backup. Explicit retry
requires a retained accepted own intent and fresh session/membership authority.
A received valid deletion or accepted equivalent request makes obsolete failures
irrelevant. Deleting a failed/pending placeholder for Me must explain that it also
hides that row's status/retry control; retain its transport record regardless.

### Content, media, location, and composition

Remove original text, attachment keys/metadata/thumbnails, coordinates, reply
previews, and projected reactions. Retain only the minimum encrypted tombstone,
author, time, and binding/delivery evidence. Do not delete a shared server blob
or send plaintext deletion metadata. Old exported files cannot be recalled.

Fence attachment fetch, decryption, caching, and download continuations before
returning or exposing data. Delete cached files where possible. UI unmount must
stop media playback and revoke object URLs. Accepted tombstones remain the read
barrier even when physical cache cleanup must retry.

For a live card, retain authenticated conversation/account/session suppression
anchored to its verified original. Later points must not recreate the session.
Stop a matching local producer and invalidate pending location callbacks; preserve
unrelated sessions. Me deletion stops a matching producer on this device. A synchronized Me
suppression stops a matching producer on the receiving own device too.
Explain that side effect in confirmation. Everyone requests received by another
own device stop that device's matching producer.
Persist native-derived original hash/author evidence with producer state. Check
suppression before advertising sharing or generating updates, including after
restart when history cannot be read. Do not reconstruct missing legacy hashes.
An unverifiable producer must not publish until its binding can be verified.
Do not stop an unrelated producer with a different verified binding. Never stop another account's
producer through a local Me operation.

Disable reply/react/original-send retry on deleted targets in the worker, not
only in UI flags. Existing replies retain their own bodies but show the original
as unavailable. Clear only an affected active reply reference. Preserve composer
text, saved draft revisions, and newer editor generations through every race.

### UI/worker contract

Add `DeletionScope = 'me' | 'everyone'` and `DeleteAccepted = { accepted: true;
scope: DeletionScope }` to the worker protocol.
Expose `deleteMessage(conversationId, messageId, scope)` and
`retryDeletion(conversationId, deletionEventId)`, returning `DeleteAccepted`.
A resolved result means local tombstone acceptance, not remote erasure.
`deleteForMeLocalOnly === false` advertises verified linked-device suppression.
A true or absent flag requires device-only fallback confirmation.

Worker-derived `ChatMessage` fields are `canDeleteForMe?`,
`canDeleteForEveryone?`, `deleteForMeLocalOnly?`, `deleteForEveryoneUntil?`, `deleted?`, and
`deletionStatus?: { id: string; status: 'sending' | 'failed'; error?: string }`.
No original hash, key, internal tombstone, or private verification evidence enters UI.
Public capability flags control affordances only. The worker rechecks all authority.

Extend the existing `CoreEvent` messages notification with optional
`deletions?: { messageId: string; scope: DeletionScope }[]`. Emit these identifiers
only after local acceptance or verified everyone deletion, never for an
unverified candidate. Include known matching identifier aliases. The UI must
redact cached rows, their reply previews, and related open media/location views
before starting a history refresh. Preserve that barrier if refresh fails or a
stale result arrives. These events convey invalidation, not authority to send.

Offer separate named actions in the existing message menu. Deletion eligibility
must not depend on `canReply`. Confirm scope explicitly; initially focus Cancel,
trap focus, support Escape, and restore focus without opening the keyboard.
After removal, focus the nearest surviving row or conversation container.
Retain native selection, links, media controls, and draft CAS fences.

## Validation

Test authenticated authors, forged bindings, legacy data, renamed copies,
unknown originals, invalid/poisoned candidates, candidate bounds, duplicates,
and exact hour boundaries. Test sender clock rollback, delayed delivery, and
retry after the deadline with the original accepted request time.

Test persistence failures before and after tombstone acceptance, simultaneous
flushes, session replacement, pending original cancellation, stale retries,
backup/reload replay, incomplete cleanup, and content-free derived views.

Test own-device Me synchronization, wrong-account/non-self/revoked senders,
unknown originals, renamed identifiers, duplicate union, chunking, offline/reload
recovery, late-device bootstrap, sync failure, and unverified local fallback.

Test text/files/location/live cards, late media and geolocation completion,
quote invalidation, reply/reaction/send races, hidden failed placeholders,
confirmation focus, cancellation, keyboard access, and narrow viewports.

Run cheap local checks before push. Regenerate the checked-in WASM declaration
contract from real pinned bindings. Run all existing units and interaction
fixtures; server-backed tests remain CI where local services are unavailable.

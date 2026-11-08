# ADR-0041: Encrypted message reactions

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** Project owner, implementation agents
- **Related requirements:** FR-MSG-7, FR-MSG-9, FR-MSG-10, FR-MSG-13, NFR-SEC-1
- **Builds on:** ADR-0022, ADR-0034, ADR-0038

## Context
Accounts need reactions on verified messages. Each account can have several MLS devices.
The server must not learn reaction targets, emoji, authors, removal state, or ordering fields.
The outer envelope message identifier is not authenticated. An identifier alone cannot authorize a reaction.
Delayed events, duplicate delivery, device clock differences, and restored history must not restore an older reaction.

## Options considered
1. Store reaction fields on the server. This reveals content metadata and requires a new API.
2. Send encrypted reaction updates through MLS and project them in the worker. This preserves the existing security boundary.
3. Send reaction text as an ordinary visible message. This creates unwanted history, quotes, receipts, and unread entries.

## Decision
Use option 2. Add `Content.reaction`, tag 14, to the encrypted body oneof.
The body contains `target` (16 bytes), `target_hash` (32 bytes), `target_author` (16-byte account), and `emoji`.
An empty emoji removes the account reaction. Supported emoji are `👍`, `❤️`, `😂`, `😮`, `😢`, and `🙏`.
Other emoji remain unsupported and do not affect projection.
`Content.sent_at_ms` supplies a positive JavaScript-safe logical timestamp.
The authenticated MLS sender supplies the reacting account and device. No reacting identity comes from the UI or reaction body.

### Target verification
The UI sends only a conversation identifier, target identifier, and selected emoji.
The worker resolves the first non-notice original in that conversation's encrypted history.
It requires the stored original `contentHash` to equal `target_hash` and its author account to equal `target_author`.
The original hash uses the exact ADR-0038 primitive, including the full authenticated original sender identity and encoded content.
This hash therefore also binds the original sender device. The redundant author field makes the account binding explicit.
The worker never computes a trusted hash from normalized history, previews, or UI hints.
Legacy originals without stored hashes cannot receive new or replacement reactions.
The worker derives `canReact` and strips all hashes and internal reaction records from UI results.
Derived verification-evidence writes are best effort. Storage failure must not hide readable history.
Only persisted evidence can authorize removal after the original hash becomes unavailable.

The worker can retain authenticated reaction updates before their originals arrive.
An unverified update has no visible effect. Projection verifies the binding when a matching original becomes available.
A changed identifier can hide an original, but cannot bind different content or another authenticated author.
A copied original and identical hash identify the same authenticated content; envelope identifiers remain unauthenticated, as in ADR-0038.

### Own removal after verification loss
A worker-only `verified` field records that an update matched a verified original.
It persists only in encrypted worker history and encrypted backup. It is not a UI protocol field.
If an original later loses its stored hash, this retained evidence can display the prior reaction and authorize its removal.
The worker must require a previously verified update with the same target, hash, author, and reacting account before accepting such a removal.
A missing hash must never authorize an addition or replacement through this exception.
An existing but different valid original hash, or a different original author, invalidates the old binding.
A completely missing original has no displayed message or chip. Its reactions remain hidden.
No retained verification field travels through metadata sync. The server cannot supply one through a reaction body.
Encrypted backup is a trusted history source, with the same integrity assumptions as original content hashes.

### Deterministic account ordering
Each original has at most 1 projected reaction per authenticated account, across all its devices.
Projection chooses the greatest tuple in this order:

1. Positive logical timestamp in `Content.sent_at_ms`.
2. Authenticated device identifier, compared as lowercase hexadecimal bytes.
3. Emoji string, compared lexically; the empty removal string sorts after every supported emoji.

Thus, removal wins a same-timestamp tie from the same device. A higher device identifier wins an equal timestamp across devices.
The worker sends at `max(Date.now(), 1 + every observed timestamp from this account in this conversation)`.
The worker validates the result as a safe integer before encryption.
A same-emoji selection sends a removal. A different emoji sends a replacement.
Outer envelope identifiers and arrival order never select a winner.
Duplicate semantic events have no effect. All tombstones survive history reload and backup.
Given the same authenticated events and verified originals, devices converge independently of arrival order.

This order does not establish real-time order between disconnected devices.
A device with an incorrect future clock can make its own reaction dominate other offline devices.
After another device observes that event, its next update advances past the observed timestamp.
A malicious account can control its own logical timestamp, but cannot edit another account's reaction.
There is no server clock, global sequencer, or new cryptographic primitive.

### Storage, transport, and compatibility
Reaction updates use normal MLS envelopes, current-member checks, and existing blocked-contact and request guards.
They use the normal encrypted durable outbox, including offline retry.
An acceptance gate blocks transport from queue insertion through successful history and app-state persistence.
The worker persists the advanced MLS sender ratchet before transport sends.
History, ratchet, or app-state write failure removes the new outbox item before the gate opens.
Cleanup marks the event as failed and retries persistence without rolling back the ratchet.
Cleanup failure must not make the rejected envelope eligible for a later flush.
Reaction and retry RPCs capture an account identifier and lifecycle epoch, not a core reference outside the mutation lock.
They check this session before encryption, after history reads, and before and after acceptance persistence.
Sign-out invalidates the session and blocks transport immediately, before waiting for the mutation lock.
An in-flight write can finish, but the stale RPC removes its envelope and retains the advanced ratchet.
Account registration advances the epoch. A queued RPC cannot use the previous core after account or device replacement.
Transport rechecks its captured session after a response and inside settlement.
A delayed response from the previous session cannot remove an envelope from a replacement account.
An envelope transmitted before invalidation cannot be recalled.
Sign-out detaches the socket and resolves its request waiters immediately, including requests held inside the mutation lock.
Old socket open, message, and close callbacks must pass both socket-identity and account/epoch checks.
Stale message callbacks must return before decoding authentication or revocation frames.
Queued authentication, key-package, and delivery work must retain the same socket/session guard.
A changed-session flush performs 1 handoff when replacement work is online and queued.
Same-session lost responses and retry backoff must not trigger this handoff or create a retry loop.
The group policy permits reactions when some group participants are blocked.
A blocked 1:1 conversation still prohibits reactions. Incoming updates from blocked senders remain ignored.
Ready-view blocking uses the same `isGroupView` classification as the worker, including renamed direct chats.
A name alone cannot turn a blocked direct chat into a group. Existing own chips and retry controls remain disabled there.
Received reaction updates do not create visible messages, unread counts, message previews, or receipts.
The normal content-free transport push behavior remains unchanged. No reaction-specific push fields exist.

Internal reaction records live in each conversation's encrypted message collection, with a `reactionEvent` field and notice marker.
They never enter UI history. Projection groups updates by target before it computes account winners.
Outgoing records use the actual envelope identifier, own sender marker, and sending, sent, or failed status.
The latest own update remains provisional until the server accepts its envelope.
The UI shows `Sending reaction…` or `Reaction not sent` for that update, including removals without a chip.
A permanent rejection or exhausted retry budget retains the event and exposes `Retry reaction`.
Failure changes delivery state, not the ordering tuple. An older failure cannot restore or replace a newer edit.
Retry requires the latest own failed update and repeats its desired emoji, not toggle semantics.
It rechecks target eligibility and creates a newer explicit update with the current authenticated device identity.
This also supports backup restoration onto a new device without forging the previous device identity.
The failed event and its tombstone remain in history. Stale retries fail instead of replacing a newer edit.
Encrypted backups preserve these records, original hashes, and removal tombstones without recomputation.
Do not prune tombstones independently of their reaction history. This implementation retains the event history.
History size limits are the existing conversation and backup limits; this change adds no history compaction scheme.
Older backup readers can show empty notice records from a newer backup; wire compatibility does not imply backup downgrade support.

Existing protobuf readers ignore tag 14 and display no reaction message.
They must still persist the MLS state after decrypting an unknown application body.
New clients continue to read old messages without reaction fields.
No server API, database schema, outer envelope field, or plaintext storage changes.

Linked devices receive future updates as independent MLS members.
Existing device sync shares metadata, not prior message history or reaction logs.
A newly linked device without verified originals cannot display or originate reactions on that missing history.
If verified history becomes available later, its retained events can project normally.
A restored backup preserves its snapshot's reactions. Events absent from that snapshot follow the existing backup delivery-gap limitation.

### UI
The existing long-press, context-menu, and keyboard message menu contains React beside Reply for eligible targets.
No persistent reaction toolbar appears on a message.
The emoji menu has named menu items, keyboard navigation, Escape dismissal, and focus restoration.
Its maximum height follows the visual viewport. Internal scrolling keeps all 6 items reachable with a keyboard open.
Internal menu scrolling does not dismiss it. Outside scrolling still dismisses it.
Aggregated chips expose counts and own state with accessible button names and `aria-pressed`.
An own chip toggles removal, including when new-reaction eligibility disappears.
A chip for another account's emoji selects that emoji only when the original is verified.
Links and native controls retain their separate interactions.

## Consequences
Reactions remain confidential through the existing worker and MLS boundaries.
Offline ordering is deterministic, but cannot prove the user's real-time intent across disconnected devices.
Retained event history costs local storage. Tombstone compaction needs a separate causal-history design.
Legacy targets fail closed rather than receiving a synthetic verification hash.
New linked devices do not gain earlier history from this feature.

## Validation
- Rust core tests exchange encrypted reactions, verify sender and conversation, and model a previous protobuf reader ignoring tag 14.
- The compatibility test restores the recipient snapshot after an ignored reaction and decrypts the next ordinary message.
- WASM tests check the encrypted binding bytes, removal encoding, sender identity, snapshots, and invalid outgoing bindings.
- Worker tests cover toggling, replacement, account ordering, multiple devices, duplicates, replay, and persistent removal tombstones.
- Worker tests reject wrong hashes, authors, conversations, legacy data, UI hints, unsupported emoji, and unauthorized senders.
- Tests deliver reactions before originals and require verified original data before display.
- Tests preserve removal evidence through verification loss and reject replacement in that state.
- An encrypted backup round trip preserves history and prevents an older reaction from overriding a tombstone.
- Chromium fixture tests cover keyboard selection, cancellation, aggregation, replacement, and own removal at 390 px and 1280 px.
- Acceptance tests delay or fail history, app-state, and ratchet writes while a concurrent flush runs. Later flushes cannot send rejected updates.
- Transport tests cover permanent rejection, exhausted retries, stale retry, failed removal reload, and an older in-flight failure after a newer edit.
- Tests cover mixed blocked groups, renamed blocked direct chats with own chips, and readable history after a failed derived-evidence write.
- The evidence-write test uses the local account as reactor and the peer as original author. Missing persisted evidence must prohibit own removal.
- Session tests invalidate queued reaction/retry RPCs, original-history reads, and history/app/ratchet acceptance writes.
- Tests replace both the same account and a different account while an old RPC waits. Neither core can encrypt the stale reaction.
- A transport test returns an old-session response after account replacement and verifies that the new outbox remains unchanged.
- Handoff tests drain replacement-session work automatically after an old response or timeout, without another send or flush.
- Socket tests resolve sign-out waiters without timeout, including a lock-held flush.
- Socket tests reject stale open/authentication/revocation/close callbacks and preserve replacement waiters.
- Socket tests stop queued authentication, key-package, and delivery work after session invalidation.
- Browser tests check failure and removal retry UI plus final-item access in a 250 px visual viewport.
- Full Chromium interaction fixtures cover existing reply, link, typing, selection, scroll, and responsive-dialog behavior.
- Database E2E, physical mobile testing, and WebKit remain CI or manual checks. Browser fixtures do not prove encrypted transport.

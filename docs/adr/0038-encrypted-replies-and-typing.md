# ADR-0038: Encrypted replies and typing

- **Status:** Accepted
- **Date:** 2026-11-06
- **Deciders:** Project owner, implementation agents
- **Related requirements:** FR-MSG-6, FR-MSG-7

## Context
Messages need reply references. Conversations need temporary typing state.
The server must not receive plaintext references or typing state.
MLS must authenticate the sender of both features.

## Options considered
1. Add encrypted content fields. Existing MLS transport authenticates and encrypts them.
2. Add server-visible events. This reveals additional metadata and needs a new transport.
3. Copy quoted text into each reply. This duplicates history and can preserve expired locations.

## Decision
Use option 1. Keep the existing encrypted envelope and MLS identity checks.
Add optional bytes `Content.reply_to`, tag 11, outside the body oneof.
A reference names a 16-byte envelope message identifier in the same conversation.
An absent or empty reference means no reply.
Malformed incoming references do not invalidate the message body. The binding omits them.
The binding exposes references only for text, attachment, location, and live-location bodies.
The sender does not supply an original author or a plaintext quote snapshot.
Add optional bytes `Content.reply_to_hash`, tag 13, outside the body oneof.
This field contains a 32-byte SHA-256 digest of the original authenticated sender identity and original content.
The worker must resolve the reference within the current conversation.
The worker must require a matching original content hash before it supplies any original text or author to the UI.
The UI must show an unavailable-original label when resolution or hash verification fails.
Missing hashes, malformed hashes, and legacy originals without stored hashes must produce the same unavailable-original result.
New outgoing replies must supply both a valid reference and its verified original content hash.
A preview must not fetch attachments or retain expired location coordinates.
The worker must expose reply eligibility without exposing original content hashes.
The UI must require `canReply === true` before it enters reply composition.
Missing legacy verification data must not cause a late send failure from an advertised reply action.
The UI must omit Reply for ineligible messages, without adding an explanation or changing the current draft or selected quote.
A pending message can become eligible after encryption records its original hash.
Reply appears in the message action menu, opened by long press, right-click, or the keyboard context-menu command.
Links must use a separate long-press action menu for Open, Copy link, and supported Share.
A link gesture must not open the message Reply menu. Ordinary link clicks and pre-existing text selections must retain their behavior.
Media and other native controls must retain their own interactions.
Timestamps, sender labels, date separators, and delivery metadata must not support text selection. Message bodies and links must remain selectable.
The conversation menu contains the typing-indicator toggle; the composer does not show an inline checkbox.

Add `Content.typing`, tag 12, with `Typing.active` and `Typing.expires_at_ms`.
Use `Content.sent_at_ms` to order updates from each authenticated sender device.
Both active and inactive updates must have an expiry.
Both timestamps must be positive JavaScript-safe integers.
The expiry must follow the sent timestamp by 1 to 10000 milliseconds.
The binding rejects invalid outgoing timestamps and ignores invalid incoming typing bodies.
The worker must reject updates with `expiresAt <= now` or `sentAt < now - 10000`.
The worker must reject timestamps more than 2000 milliseconds in the future.
The worker must compare timestamps within each authenticated device and conversation.
An older update must not replace a newer update.
At equal timestamps, an inactive update can replace an active update. An active update must not replace an inactive update.
Duplicate active updates must not extend a lease. Duplicate inactive updates must not change ordering state.
The sender must generate increasing timestamps, including stop events.
The worker must limit visible expiry to `min(expiresAt, now + 10000)`.
The worker must retain ordering state after the visible indicator expires.
An inactive update creates a tombstone, even if no active lease exists.
The worker can prune a tombstone only when `now > tombstone.sentAt + 10000`.
This horizon uses the sender timestamp, not the receipt time.
An older start has `expiresAt <= start.sentAt + 10000 <= tombstone.sentAt + 10000`.
Thus, an older start must be expired after the tombstone horizon. Future clock tolerance does not extend this horizon.
All lease operations must use a nondecreasing receiver time during the signed-in session.
Monotonic elapsed time must advance this time even when the wall clock moves backward.
An active lease must still expire within its remaining lifetime after a wall-clock rollback.
The worker must retain the receiver time floor when individual leases or conversation maps become empty.
A backward wall-clock change must not make a discarded update fresh again.
The UI must also use monotonic elapsed time for typing refresh throttles.
A newly accepted live-location card must establish the sender device's typing tombstone.
Background updates to an existing live-location card must not stop a newer draft.
A visible send must reserve its composition timestamp before asynchronous preparation or stopping a previous live session.
Completion must not stop a newer draft.
Text sends must serialize the typing stop and message creation in one mutation.
The worker must clear leases when permissions, membership, conversation state, or account state no longer permit display.
The worker must bound this state and clear it when the conversation or account ends.
The worker must apply current-membership, blocked-contact, and message-request checks before display.
The worker must aggregate active devices by account for the UI.
Typing must not enter history, unread counts, receipts, notifications, backup, or durable offline replay.
The sender must rate-limit updates and avoid sending them while offline.
The worker must still persist MLS ratchet changes before transport sends.

## Binding contract
The existing methods accept optional final `replyTo: Uint8Array` and `replyToHash: Uint8Array` arguments:

- `sendText(conversationId, body, sentAtMs, messageId, replyTo?, replyToHash?)`
- `sendAttachment(conversationId, attachment, sentAtMs, messageId, replyTo?, replyToHash?)`
- `sendLocation(conversationId, latitude, longitude, accuracyM, label, sentAtMs, messageId, replyTo?, replyToHash?)`

Empty arrays count as absent. Ordinary sends must omit both values.
A reply must supply a 16-byte identifier and a 32-byte hash together. The binding rejects other combinations.
Incoming malformed fields do not prevent reading the reply body. The binding omits malformed fields.

Add `sendTyping(conversationId, active, sentAtMs, expiresAtMs, messageId)`.
Each method returns the encoded encrypted envelope.
Existing callers can omit the optional final argument.

`EventView` adds `replyTo`, `replyToHash`, `contentHash`, `typingActive`, and `typingExpiresAtMs`.
The binding computes `contentHash` for each visible message before it normalizes fields for the UI.
The hash uses the full authenticated MLS sender identity, including the device identifier.

The exact digest is `SHA256(domain || u64le(identity.length) || identity || Content.encode_to_vec())`.
The domain is the UTF-8 bytes `chat.reply-content.v1` followed by one zero byte.
The content encoding is the decoded prost `Content` encoding, including optional field presence and reply metadata.
Do not hash a preview, a stored normalized message, or an account identifier without its device identifier.

The getter `core.lastSentContentHash` returns the hash after a successful visible-message send.
The worker must read this getter inside the send serialization lock, before another send can replace it.
A non-visible send clears the getter. A restore initializes it as absent.
The worker must store this hash with its own original message. Received originals use `EventView.contentHash`.
History and backup must preserve hashes without recomputing them from normalized fields.
Retry must preserve reply identifier and hash together. It must record the hash of the actual retried content.
These fields are undefined when absent. An inactive typing update has `typingActive === false`.
Typing uses the existing `kind === 'message'` event.
The existing `sender`, `conversationId`, and `sentAtMs` fields supply authenticated context.
Invalid typing timing produces `kind === 'ignored'`.

## Consequences
Existing protobuf readers ignore the new fields.
Existing clients display reply bodies without quotes and ignore unknown typing bodies.
No server API or storage schema change is necessary.
Generated Rust `Content` initializers need the new optional field.
The WASM package must be rebuilt before worker integration.
Worker history and retry paths must retain reply references and hashes.
New members and linked devices can lack an original. This does not prevent reading a reply.
Timing uses sender clocks. The receiver accepts at most 2000 milliseconds of future clock skew.
The receiver does not extend sender expiry for slow sender clocks.
Clock differences can shorten indicators or suppress them. Privacy takes priority over indicator availability.
A forward receiver clock change can suppress indicators until sender time catches up.
The receiver time floor prevents a later backward clock change from restoring stale indicators.
A malicious member can send false typing state. MLS authenticates identity, not user intent.
Server traffic timing remains visible, as with other encrypted messages.

### Original identifier integrity
The current envelope stores `message_id` outside the MLS ciphertext.
The current MLS encryption call does not bind this identifier as authenticated data.
The worker indexes original messages with that outer identifier.
The encrypted content hash binds the selected original content to its authenticated author and device.
Identifier substitution cannot produce a verified quote for different content or a different authenticated sender.
The server can still hide, rename, or drop originals. These actions produce unavailable quotes, not substituted quotes.
Legacy received content can have a computed hash. Older local history without stored hashes remains unverified.
Do not derive trusted hashes from older UI-normalized history.
Future schema changes can alter prost encoding after unknown fields are discarded. Such mismatches must produce unavailable quotes.
This change does not repair the outer identifier format for other identifier-based features.

## Validation
Rust tests must exchange replies and active and inactive typing through MLS and check the authenticated sender.
Compatibility tests must decode replies with the previous schema and decode previous messages with the new schema.
Binding tests must check timestamp boundaries and malformed timing.
Rust tests must check hash agreement through MLS, sender identity changes, content changes, and optional field presence.
Compatibility tests must confirm that previous readers ignore the content hash field.
Worker tests must reject original substitution, missing hashes, and mismatched hashes without exposing an original author or preview.
Worker tests must check expiry, reordering, clock skew, multiple devices, and membership checks.
Tests must show that an equal-timestamp stop overrides a start, but an equal-timestamp start cannot override a stop.
Tests must check delayed starts before, at, and after the tombstone horizon, including the 2000-millisecond future boundary.
Tests must prune a tombstone, move the receiver wall clock backward, and confirm that an older start cannot restore the indicator.
A received visible message must establish an ordering tombstone even when no active lease exists for its authenticated device.
Tests must deliver a text message before an older typing start and confirm that the start cannot restore the indicator.
UI tests must check cancellation, unavailable originals, keyboard access, and sender labels.

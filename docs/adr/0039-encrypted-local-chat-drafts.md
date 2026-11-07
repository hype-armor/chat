# ADR-0039: Encrypted device-local chat drafts

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** Greg
- **Related requirements:** FR-MSG-1, FR-MSG-14, NFR-SEC-1

## Context

The conversation component currently owns unsent text. Switching conversations destroys that component and loses the text. Closing the app also loses it.

A restored draft must not replace text entered while storage was loading. A delayed send must not clear a newer draft, even when both drafts contain identical text.

Draft storage must follow the worker boundary. The UI must not use localStorage, IndexedDB, encryption keys, or network requests to persist drafts.

## Options considered

1. **Component state only.** Simple, but it loses drafts during navigation and app termination.
2. **UI browser storage.** It preserves text, but it violates the worker boundary and can store plaintext.
3. **Encrypted worker storage with revision fences.** It preserves device-local drafts and ties consumption to durable send acceptance.
4. **Server or linked-device draft synchronization.** It adds protocols and metadata that this request does not require.

## Decision

Use the existing encrypted `SecureStore` in the core worker. Store exact text separately for each account and conversation. Preserve whitespace locally; trim only the transmitted text.

Each stored draft has a numeric revision. Missing drafts start with empty text at revision 0. Every accepted edit advances the revision, including empty or identical-text edits.

The worker exposes load and compare-and-save operations. A save uses the expected revision and returns the current draft on a conflict. Empty records retain revision tombstones.

The UI keeps a per-conversation coordinator above the keyed conversation view. It queues each edit immediately. It must not depend on debouncing, unmount, or an unload handler to initiate saving.

The coordinator tracks editor generations independently from stored revisions. Restore, save, and send completions must not replace newer edits. Normal saving stays quiet; failures show an actionable error without erasing text.

A submitted message carries its saved draft revision. The worker consumes that revision only when its stored text matches the submitted text after trimming.

The worker persists a local clearing fence in the same app record as the accepted outbox entry. A later draft revision survives the fence. No separate UI clear request follows a successful send.

An acceptance response explicitly identifies the consumed revision. The UI must not infer ownership of a clearing fence from an empty draft snapshot. Only confirmed local consumption can authorize automatic rebasing after a save conflict.

Storage acknowledgement must wait for IndexedDB transaction completion. A failed acceptance must not consume the draft. Cleanup of a fenced record must not reject an already accepted send.

Attachment preparation captures caption text and editor generation before asynchronous work. A late attachment completion must not clear newer typed text. This decision does not persist files or recordings.

Draft records and clearing fences stay outside backups, linked-device history, and server requests. Only an explicit send converts typed text into message content.

Leaving, removal, conversation deletion, and account reset must invalidate pending draft operations before cleanup. Old operations must not recreate a discarded draft.

## Consequences

- Draft text survives conversation navigation and normal app restarts on the same browser profile and device.
- A draft is not a message. It does not appear in conversation history or generate network traffic.
- Reply-quote persistence, file persistence, cross-device synchronization, and concurrent-tab synchronization remain outside this decision.
- Revision checks protect one engine and its client queue. They do not add a cross-tab lock to the existing engine.
- Browser storage eviction, cleared site data, and termination before a write commits can still remove unsaved edits.
- A rejected send can restore its text when the composer remains untouched. Separate failed-send recovery items remain session-only when newer text exists.

## Validation

Test exact whitespace, separate conversations, encrypted storage reuse after restart, and backup exclusion.

Test edits during restore, ordered saves, save failures, conflicts, identical-text revisions, and pending sends across view changes.

Test durable send acceptance, failed acceptance, cleanup failures, and lifecycle invalidation. A newer draft must survive every stale completion.

Run UI regressions for conversation switches and app reload, alongside existing reply, typing, attachment-caption, and menu tests.

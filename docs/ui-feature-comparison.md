# Chat interaction comparison

Status: scoped implementation review. Baseline: GitHub main `bcc6f32`.

## Evidence and limits

This document compares message interactions, not complete products or security architectures.
No live Signal, WhatsApp, or Telegram client was tested for this review.
The reference column describes general product behavior. Platform, version, settings, and permissions can change that behavior.
It is not verified evidence of current behavior on any specific release.

Repository evidence comes from source and existing tests at the baseline commit.
Test presence does not prove that a test passed. New tests require integration and execution.

| Scope | General reference behavior: Signal | General reference behavior: WhatsApp | General reference behavior: Telegram | Repository evidence at baseline |
| --- | --- | --- | --- | --- |
| Links | Clickable URLs; platform actions can open, copy, or share them | Clickable URLs; platform actions can open, copy, or share them | Clickable URLs; context actions can open, copy, or share them | `web/src/ui/Chat.tsx` renders message text as a text span. No message-link action component appears in this path. |
| Quoted replies | A reply identifies an earlier message | A reply identifies an earlier message | A reply identifies an earlier message | No reply composer or message quote appears in `Chat.tsx`. |
| Typing | Optional transient typing indicators | Transient typing indicators | Transient typing indicators | No typing indicator appears in `Chat.tsx`. |
| Scroll | Conversation views generally follow new content near the bottom and permit history reading | Similar general interaction | Similar general interaction | `Chat.tsx` tracks bottom proximity, observes size changes, and shows a new-message button. Own sends force the bottom. |
| Media growth | Clients generally reserve or adjust media layout | Similar general interaction | Similar general interaction | `Attachment.tsx` reserves known aspect ratios. `Chat.tsx` observes content growth. |

The reference descriptions do not establish equivalent encryption, metadata protection, or retention guarantees.
In particular, Telegram cloud chats and secret chats have different security models.
This project must retain its own encryption and worker boundaries regardless of reference behavior.

## Prioritized scope

### P0: Preserve reading position and safe navigation

- Keep own-send-to-bottom behavior. Keep conversation opening at the latest message.
- Follow incoming messages only when the reader is near the bottom.
- Preserve the visible message position when the reader scrolls up.
- Test viewport changes and delayed media growth in pinned and unpinned states.
- Render supported web links without remote previews, third-party scripts, or background URL fetches.
- Open external links with opener isolation. Copy the exact destination. Share through browser capability, with a usable fallback.
- Keep unsafe schemes as plain text. Do not treat arbitrary message text as HTML.

### P1: Quoted replies

- Let a reader select Reply and cancel it without losing the draft.
- Send a stable reference to the original message through the encrypted content path.
- Resolve quote text from local history. Do not trust an arbitrary remote plaintext quote.
- Show a clear missing-original state. A reply must remain readable if the original is unavailable.
- Support keyboard access and narrow screens.

### P1: Transient typing

- Deliver typing through the approved encrypted core path, not direct UI networking.
- Scope indicators to the conversation. Do not persist typing as history.
- Expire stale indicators, including when no stop event arrives.
- Stop the indicator after send or draft clearing. Avoid unlimited updates for each keystroke.

### Deferred

Rich URL previews, remote thumbnails, message editing, reactions, threads, delivery analytics, and product-wide parity remain outside this change.

## Test and integration map

- `web/e2e/chat.spec.ts` already covers open, own send, incoming messages, history reading, and synthetic growth at desktop and phone widths.
- `web/e2e/pwa.spec.ts` already checks simulated visual-viewport panning and pinned keyboard layout.
- `web/e2e/fixture-scroll.spec.ts` adds unpinned keyboard and real-image growth checks at 390 and 1280 pixels. It keeps own-send-to-bottom behavior.
- `web/e2e/message-interactions.spec.ts` defines link, reply, missing-original, and typing acceptance tests.
- `web/src/test-fixtures/interactions.tsx` mounts the real chat UI with an in-memory core. Two pages exchange fixture events through `BroadcastChannel`.
- The fixture uses the real `TypingLeases` class. It can drop stop events to test lease expiry. It does not implement encryption or durable storage.
- Fixture reply previews model local resolution only. They do not verify message hashes or cryptographic integrity. Real worker and MLS tests must verify those properties.
- Missing-original coverage supplies an unresolved local reference through the mock core. CI must also verify replies on a real linked device without earlier history.
- `web/playwright.fixtures.config.ts` runs only these UI fixtures on port 14173. It starts no Rust server or database.
- `web/playwright.interactions.config.ts` runs existing real-server chat regressions on preview port 14173 and server port 18080, with reuse disabled.
- Real-server tests require `E2E_SERVER=1` and an explicit `E2E_ISOLATED_DATABASE_URL`. The database name must start with `chat_ui_e2e_`.
- Do not run against live ports or a shared database. Local Docker access is unavailable; real-server execution remains a CI integration task.

Run the local fixture suite with `TMPDIR=/var/tmp pnpm --filter web exec playwright test -c playwright.fixtures.config.ts`.
The dedicated fixture configuration enables these tests. The normal preview configuration skips them.
The fixture entry is not part of the production HTML entry or the worker.
The development fixture runner does not establish production CSP compliance; retain the production-header tests.

### Local execution evidence

- Chromium passed the first 11 fixture cases, including link errors, share cancellation, failed-send draft isolation, typing expiry, and mid-history media growth.
- Firefox passed those same 11 cases.
- A later 12th case reproduced a queued-scroll/container-resize failure on Chromium. It moves message 20 and resizes in one evaluation, without dispatching a scroll event.
- That regression test remains active. The UI owner must fix the position reset before the full suite can pass.
- WebKit could not launch because the local host lacks required libraries. No WebKit behavior was verified.
- `TMPDIR=/var/tmp pnpm --filter web exec tsc -b --force --noEmit` passed after the DOM configuration fix.
- `PW_ALL_BROWSERS=1` enables Chromium, Firefox, and WebKit in the fixture configuration. CI must install each engine and its host dependencies.
- Real-server integration was not run locally. Existing live services remained untouched.

Browser emulation does not verify a real operating-system keyboard or native share sheet.
Run these tests on Chromium, Firefox, and WebKit. Perform a separate phone check for keyboard and native sharing behavior.

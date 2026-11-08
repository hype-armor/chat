# UI quality-of-life review

Scope: bounded UI changes on baseline `2d86941`. No protocol, storage, server, or cryptographic changes.

## Observed issues and corrections

The review used the real React UI and isolated in-memory core fixtures in Playwright.
It inspected 320, 390, and 1280 pixel layouts and captured screenshots.
The fixture runner used dedicated port `14203`. It contacted no deployment.

| Observed baseline | Correction |
| --- | --- |
| Opening a phone conversation left focus on `BODY`. Back also lost focus. | Focus the conversation region without focusing the textarea. Back restores its conversation row. Message updates do not refocus the region. Calls retain focus priority. |
| At 320 pixels wide, the Conversation menu ended at 316 pixels in a 240 pixel viewport. Final commands were clipped. | Bound menu height to the visual viewport. Preserve upward-opening attachment and call menus. Scroll keyboard-focused commands fully into view. |
| A failed initial history load showed an error with no retry action. | Add an explicit history retry with busy state. Preserve loaded messages and editable drafts. Ignore stale request failures. |
| Offline feedback existed only in the sidebar, which disappears on phones while a chat is selected. | Show the existing offline/connecting state under the conversation title. Hide it online. Do not add a global banner or change queuing behavior. |

Firefox initially left the final focused menu item partly clipped after adding overflow alone.
Explicit nearest-item scrolling corrects that behavior without changing keyboard commands.

Independent review found 2 additional details:

- Upward call menus anchor 16 pixels above the trigger edge. Use the actual popup edge
  for viewport space and retain any stricter computed CSS maximum height.
- Native `disabled` blurs a focused history retry button. Keep it focusable with guarded
  `aria-disabled` while busy. Restore conversation context only if retry still has focus.

## Regression coverage

`web/e2e/quality-of-life.spec.ts` covers:

- Region and return-row focus, retained drafts, and no focus theft on incoming messages.
- Short viewport menu bounds, End/Home navigation, Escape, and upward attachment menus.
- Actual `CallScreen` output menus with 6 synthetic devices at 320 and 1280 pixels.
  Both the normal CSS cap and a stricter 88 pixel cap must hold.
- A modeled panned visual viewport.
- Initial and later history failures, retry busy state, ongoing editing, and stale response isolation.
- Held keyboard retry with no later UI interaction, successful focus restoration, and guarded duplicate activation.
- Visible disconnected feedback without horizontal overflow.
- Existing long-filename attachment download and keyboard retry behavior.

Run the isolated tests with:

```sh
TMPDIR=/var/tmp PW_ALL_BROWSERS=1 E2E_UI_FIXTURE_PORT=14203 \
  pnpm --filter web exec playwright test -c playwright.fixtures.config.ts \
  --project=chromium --project=firefox e2e/quality-of-life.spec.ts
```

These fixtures do not prove encrypted delivery, real offline queues, persistent storage,
physical keyboard geometry, native mobile permission behavior, or screen-reader announcements.
Real attachments remain worker-owned. The fixture supplies synthetic blobs and failures only.
The separate call-menu fixture renders a synthetic active call. It does not start a call,
request media, or send signaling. It does not validate call transport or encryption.

## Validation results

- Typecheck, 274 unit tests, production build, and `git diff --check` passed.
- After the 2 independent-review corrections, all 95 Chromium fixture cases passed in one run.
- All 21 Firefox review cases passed after the corrections and final test refinements.
- After matching `aria-disabled` styling to native disabled buttons, all 12 targeted history/call-menu
  cases passed in Chromium and Firefox. Typecheck and diff checks also passed again.
- The earlier 184 Chromium/Firefox cases passed before those corrections. That run used separate
  commands after a 650-second command limit. The full Firefox suite needs a new integration run.
- Controlled checks temporarily restored the old behavior. The new call-menu tests detected viewport
  overflow. The held retry test detected lost focus in Chromium and Firefox. The fixed source was restored.
- No test assertion failed in the final runs. No timeouts or assertions were weakened.
- WebKit, live services, and physical devices were not tested. No Cargo build ran.

## Other findings, not implemented

- Empty conversation history has no introductory guidance. Keep any future hint quiet and contextual.
- Failed-send recovery can repeat the same error in the main error area and recovery card.
- Long histories have many keyboard-focusable message actions. A composer skip-link needs a separate interaction decision.
- The requirements narrative still mentions an unavailable-reply explanation. The current UI intentionally omits ineligible Reply actions.
- Reactions and GIF search remain outside this review.

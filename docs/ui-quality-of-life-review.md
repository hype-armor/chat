# UI quality-of-life review

Scope: bounded UI and media-handling corrections. The initial review used baseline
`2d86941`; integration includes main `4302444` and media fix `68daf9f`.
No protocol, storage format, server, or cryptographic primitive changes.

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
| A missing image thumbnail removed the photo open control. GIF thumbnail failure rejected a send even though the encrypted original was usable. | Keep an accessible open control without a thumbnail. Treat GIF previews as optional, preserve original animation bytes, and inherit readable text color. |

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

`web/e2e/gif-fixture.spec.ts` also covers original byte preservation through worker
encryption, animation, saving, optional previews, and light/dark fallback contrast.
MIME-negative cases ensure a `.gif` extension does not permit unsupported inline types.
The server-backed attachment suite adds caption and received-GIF-byte coverage.

Run the isolated tests with:

```sh
TMPDIR=/var/tmp PW_ALL_BROWSERS=1 E2E_UI_FIXTURE_PORT=14203 \
  pnpm --filter web exec playwright test -c playwright.fixtures.config.ts \
  --project=chromium --project=firefox e2e/quality-of-life.spec.ts
```

These fixtures do not prove encrypted delivery, real offline queues, persistent storage,
physical keyboard geometry, native mobile permission behavior, or screen-reader announcements.
Real attachments remain worker-owned. The general UI fixture supplies synthetic blobs
and failures only. The separate GIF fixture uses real worker attachment encryption,
but does not establish MLS delivery or server upload/download recovery.
The separate call-menu fixture renders a synthetic active call. It does not start a call,
request media, or send signaling. It does not validate call transport or encryption.

## Validation results

- After integrating current main and media fallbacks, typecheck, 300 unit tests,
  production build, and `git diff --check` passed.
- The full Chromium/Firefox run recorded 215 passes out of 216 cases. All 42 new
  QoL cases and 18 GIF cases passed. One older Firefox typing test exhausted its
  30-second whole-test budget while waiting for a real-time 8-second lease.
- Three instrumented original-test runs measured expiry after 8.0–8.5 seconds.
  The original failure artifact cannot distinguish slower setup from delayed
  fixture sweeps. No production regression or background throttling was reproduced.
- The typing test now uses controlled page clocks. It requires visibility at
  `TTL − 1ms`, expiry after the next 100ms sweep, preservation of the draft,
  a fresh typing start, and clearing after send. Its timeout remains 30 seconds.
- The corrected test passed 6 repeated Chromium/Firefox cases. Related typing
  regressions passed 10 cases. Negative controls with 7-second and 9-second
  leases failed the respective boundary assertions. No assertions were weakened.
- Independent-review negative controls also detected the original upward-menu
  overflow and held-retry focus loss. The corrected production source was restored.
- A fresh full combined-stack run remains pending. Database-backed attachment
  delivery, WebKit, physical devices, and screen readers require CI or manual checks.
  Local fixture results do not establish native permission or keyboard behavior.

## Scope and follow-ups

- Empty conversation history has no introductory guidance. Keep any future hint quiet and contextual.
- Failed-send recovery can repeat the same error in the main error area and recovery card.
- Long histories have many keyboard-focusable message actions. A composer skip-link needs a separate interaction decision.
- The requirements narrative now matches the existing fail-closed Reply behavior: hide ineligible actions and reject stale eligibility at send time.
- Reactions use a separate PR. GIF search remains on hold for provider permission; this pass adds no provider, catalog, or external origin.

# Working on this repository

End-to-end encrypted chat service: Rust core (MLS via OpenMLS, compiled to
WebAssembly for the browser), Rust server, React PWA. Design docs and ADRs
in `docs/`; read `docs/README.md` first.

## Workflow

- Until the **first production release**, Claude opens pull requests and
  merges them itself once CI is green and there are no merge conflicts
  (owner's instruction, 2026-10-29). After that release, PRs wait for the
  owner's approval.
- Use merge commits (keep the commit history of each PR).
- Significant design changes need an ADR (`docs/adr/0000-template.md`).

## Checks before pushing

Run fast, deterministic checks locally before every push, or enforce them in a
pre-push hook: formatting, configured lint, type checks, and focused unit tests
for changed behavior. Do not use CI as the first check for these failures.
The web workspace currently has no configured formatter or lint command; report
that gap rather than claiming those checks passed. Keep the broader checks below.

CI must gate compilation, integration, browsers, and publication on cheap checks.
Read `docs/ci.md` before changing workflows. PRs call CI directly; Images calls the
same reusable CI for main/tag pushes before publishing. Do not duplicate push runs
or bypass failed/skipped gates. Run `actionlint` and `python3 scripts/test-ci-graph.py`
for workflow changes. Regenerate the checked-in WASM declaration contract with
real bindings; do not hand-edit it or replace the later full-runtime test suite.

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy -p chat-core --target wasm32-unknown-unknown --features wasm -- -D warnings
DATABASE_URL=postgres://... cargo test --workspace
scripts/build-wasm.sh && pnpm typecheck && pnpm test && pnpm build
E2E_SERVER=1 DATABASE_URL=postgres://... pnpm --filter web e2e
```

## Ground rules

- No hand-rolled cryptography; no plaintext or extra metadata on the server.
- Message deletion follows ADR-0048: Me syncs verified suppression across own
  devices through authenticated private DeviceSync; unverified originals stay
  device-only. Everyone requires an authentic own original and a request within
  1 hour. Keep hash/author tombstones
  and immutable retry intent before erasing content. Never reconstruct legacy
  hashes, expose tombstone internals to UI, or let replay/media/draft callbacks
  restore deleted content. Transport capsules are encrypted, minimal, and excluded
  from history, UI, search, downloads, and backup. Rebuilt sidebar previews must
  preserve missed-call notices, exclude other notices/reaction controls, and honor
  deletion tombstones.
- Storage writes must reserve ciphertext bytes in the shared quota ledger before object-store I/O
  (ADR-0040). Release charges only after confirmed deletion and fenced writers. Account send
  limits must remain inside the authorized send transaction. Operator policy changes must use
  the shared storage-policy lock. Keep quota fetches in the core worker and account-scoped.
- No third-party scripts or origins in the web client (strict CSP; Trusted
  Types policy in `web/src/trusted-types.ts`).
- Keys, storage and networking stay in the core worker, never on the UI thread.
- GIF attachments must keep their original bytes, not a canvas frame. Thumbnails
  are optional previews. Keep MIME allowlisting; a `.gif` extension alone does not
  permit inline rendering. Run `gif-fixture.spec.ts` with the isolated fixture config.
- Device sync must bind directory results to the account/session and ordered MLS
  membership captured before directory requests (ADR-0022). Never remove an
  unqueried member. Recheck snapshots under the mutation lock after async waits;
  discard stale plans and schedule a coalesced retry. Preserve additions before removals.
- Chat drafts use encrypted device-local worker storage (ADR-0039), not UI browser storage.
  Keep drafts outside backups and sync. Clear only the accepted draft revision, never by text equality.
- Persist upload retry work before publishing `sending`. History recovery must not classify an active
  retry as an unaccepted send. Keep retries in the core worker and retain sealed bytes for resumption.
- Quoted replies resolve originals only within their conversation in the worker
  and verify the encrypted content hash; outer envelope IDs are not authenticated.
  Typing indicators use encrypted, expiring events, not history or persistent retries
  (ADR-0038). Never include draft text in typing events.
- Message reactions use verified original hashes in the worker (ADR-0047). Never
  reconstruct legacy hashes, trust UI eligibility hints, or prune removal tombstones alone.
  Gate reaction transport until history, ratchet, and app-state acceptance succeeds.
  Fence reactions and retries by account and lifecycle epoch across async reads/writes.
  Sign-out must stop new transport immediately; stale responses must not settle a new account.
  Keep failed updates visible and retryable; an older failure must not undo a newer edit.
  Reactions use the message action menu, not a permanent toolbar. Keep the emoji
  picker scrollable within the visual viewport and own removal accessible.
- UI regression tests must cover native link selection, quoted replies, typing
  expiry, message/link action gestures, non-selectable message metadata, and scroll position
  during keyboard/media resize. The idle composer must not reserve an empty
  typing-indicator row or inherit gaps from generic form styles.
  Reply actions require worker-confirmed eligibility. Own sends reach the
  bottom; incoming messages must not displace a reader who scrolled up.
  Map error fallbacks must preserve map dimensions so dialog controls do not move
  during activation. Map labels must use bundled/local resources, not external glyph or sprite
  origins. Accuracy areas must use the reported radius in metres and update with live fixes.
  Preserve account-scoped conversation reading positions across navigation. Keep the
  scroll-to-bottom chevron available whenever the viewport is not at the bottom.
  Put derived locality below the contact name, not inline; each line must use the available header width independently.
  Image viewers must use worker-opened attachments, make background regions inert,
  release object URLs, and yield focus to incoming call dialogs.
  Fixture data mutations do not guarantee rendered rows. Await
  the intended row identity/count before focusing it or opening its action menu;
  a live `last()` locator can still resolve an older row during history refresh.
- Live sharing has no app-wide banner or layout offset. Keep the conversation-list
  sharing icon, live message card and Stop sharing control. The Conversation menu
  must offer Stop sharing location for active shares, even with an expired or
  off-screen card. Removing the banner must not stop the watcher or change expiry.
- The synthetic bot world is offline configuration (`docs/bot-social-world.md`, ADR-0043).
  The separate opt-in runner follows ADR-0044 (`docs/ai-bots.md`); its CLI defaults to local
  synthetic text (ADR-0045). Synthetic generation must receive only a cancellation signal,
  never prompts or human text. Preserve AI quota on mode switches and apply the synthetic
  traffic budget to retries. Keep friendship separate from MLS membership.
  Require unanimous authenticated human consent before external inference;
  reset consent/context on membership/device or disclosure changes. Observe revocation before queued I/O,
  fence sends against unacknowledged room events, and never replay stale AI outbox work autonomously.
  Keep keys/state encrypted, inference free-only, and quota reservations durable before requests.
  Run `pnpm bots:world:test` and `cargo test -p chat-bot`; never activate bots against a live deployment for tests.
  `update-with-bots.sh` is a separate Compose updater (ADR-0046); preserve the operator's
  `update.sh`. Bot registration/start requires `--enable-bots`. Never replace missing
  keys over existing state or bypass bootstrap quotas. Run `scripts/test-update-with-bots.sh`
  with mock services after updater changes; keep bot config outside Git and build context.
- Run browser tests against isolated test services, never a live deployment.
- Browser and OS permission grants belong to the browser. Do not cache fake grants or keep
  idle camera/microphone streams to avoid prompts. Prevent duplicate capture requests and
  stop active or late-granted tracks when the requesting operation ends.
- Derive `Near city, region` only in the worker, with bundled offline data, from the peer's
  authenticated location/live messages explicitly shared in that conversation (ADR-0042).
  Existing Send location and live-share controls supply consent; no global watcher or coarse-only broadcast.
  No own/group/request sources or legacy standalone locality bodies. Cap headers at 1 hour from source time;
  clear the current source on live stop/expiry, but do not let an old-session stop clear a newer unrelated share.
  Retain source-device provenance; authorize stops by canonical peer account/session, including another current authenticated peer device.
  Same-member rekeys/device addition preserve live consent. Prune removed/ineligible sources without permanent session stops;
  retain explicit stop/block tombstones. Ordering and tombstone lookups must reject inherited records, including after JSON restore.
  Run lazy lookup outside the receive lock; re-enter `exclusive()` only to validate and publish.
  Never restore older labels as fallback or reconstruct headers on history load, request acceptance, unblock, or restore.
  Clear old global consent/caches without migration broadcasts. Retain queued MLS ciphertext to avoid ratchet gaps.
  Keep derived caches account/conversation-scoped and outside backup/sync; preserve approximate wording and GeoNames attribution.
- Rust Docker build stages must retain the shared BuildKit Cargo lock and CPU-sized
  job budget. Use `scripts/compose-build.sh` for sequential image builds and run
  `scripts/test-compose-build.sh` after changes to build controls.
- Run responsive UI and interaction fixtures with
  `PW_ALL_BROWSERS=1 pnpm --filter web exec playwright test -c playwright.fixtures.config.ts`.
  These fixtures do not prove call transport. The narrow-header echo-call test
  needs the isolated server and echo bot. Set `E2E_UI_FIXTURE_PORT` to a free
  dedicated port when another session runs UI fixtures. Call UI fixtures must
  assert the fail-closed error and keyboard dismissal when `canEncryptCalls()`
  is false. Do not bypass the encrypted-media capability guard. For calls across
  viewport sizes, use `conversationCall` from `web/e2e/support.ts`; narrow headers
  place call actions in the conversation menu.
- Opening a conversation must move keyboard context to its region, not open the
  software keyboard. Back must return focus to the conversation row. History retry
  must preserve messages and drafts and must not steal focus from ongoing editing.
  Busy history retry must retain focus with guarded `aria-disabled`, not native
  `disabled`. Generic menus must keep keyboard-focused actions visible in short or
  panned visual viewports. Bound upward menus from their actual popup edge and
  preserve stricter CSS height caps. Selected conversations must expose offline/connecting feedback even
  when the phone sidebar is hidden.
- Contact-name/avatar clicks open the existing contact-details modal for authorized shared-location cards.
  Keep the conversation menu separate and retain its accessible recipient/status description.
  Opening details must not request a position or reconstruct the locality header.
- Details modals must make background app regions inert, including the sidebar
  and notices outside Chat. Call dialogs take priority and must receive keyboard
  focus without interference from details focus restoration.
- For new or updated E2E composer selectors, use
  `getByRole('textbox', { name: 'Message', exact: true })`.
  Partial label matches can select other message controls.
- E2E specs import `test` from `web/e2e/fixtures.ts`, not directly from
  `@playwright/test`. The fixture closes manually created client contexts
  after each test, including failures; the browser itself is worker-scoped.
- Keep layout-activity probes test-only. Restore instrumented browser APIs in
  `finally`, and poll for a quiet window instead of fixed post-transition sleeps.
- Playwright tracing already covers explicit client contexts. For signup-stall
  diagnosis, use `docs/testing-webkit-navigation.md`; keep traces synthetic and
  short-lived, and never post trace contents or generated keys in public comments.

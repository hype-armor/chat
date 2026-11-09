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
- Message deletion follows ADR-0042: Me syncs verified suppression across own
  devices through authenticated private DeviceSync; unverified originals stay
  device-only. Everyone requires an authentic own original and a request within
  1 hour. Keep hash/author tombstones
  and immutable retry intent before erasing content. Never reconstruct legacy
  hashes, expose tombstone internals to UI, or let replay/media/draft callbacks
  restore deleted content. Transport capsules are encrypted, minimal, and excluded
  from history, UI, search, downloads, and backup.
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
- Quoted replies resolve originals only within their conversation in the worker
  and verify the encrypted content hash; outer envelope IDs are not authenticated.
  Typing indicators use encrypted, expiring events, not history or persistent retries
  (ADR-0038). Never include draft text in typing events.
- Message reactions use verified original hashes in the worker (ADR-0041). Never
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
  during activation.
- Live sharing has no app-wide banner or layout offset. Keep the conversation-list
  sharing icon, live message card and Stop sharing control. The Conversation menu
  must offer Stop sharing location for active shares, even with an expired or
  off-screen card. Removing the banner must not stop the watcher or change expiry.
- Run browser tests against isolated test services, never a live deployment.
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

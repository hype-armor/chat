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
- No third-party scripts or origins in the web client (strict CSP; Trusted
  Types policy in `web/src/trusted-types.ts`).
- Keys, storage and networking stay in the core worker, never on the UI thread.
- Chat drafts use encrypted device-local worker storage (ADR-0039), not UI browser storage.
  Keep drafts outside backups and sync. Clear only the accepted draft revision, never by text equality.
- Quoted replies resolve originals only within their conversation in the worker
  and verify the encrypted content hash; outer envelope IDs are not authenticated.
  Typing indicators use encrypted, expiring events, not history or persistent retries
  (ADR-0038). Never include draft text in typing events.
- UI regression tests must cover native link selection, quoted replies, typing
  expiry, message/link action gestures, non-selectable message metadata, and scroll position
  during keyboard/media resize.
  Reply actions require worker-confirmed eligibility. Own sends reach the
  bottom; incoming messages must not displace a reader who scrolled up.
  Map error fallbacks must preserve map dimensions so dialog controls do not move
  during activation.
- Run browser tests against isolated test services, never a live deployment.
- Run responsive UI and interaction fixtures with
  `PW_ALL_BROWSERS=1 pnpm --filter web exec playwright test -c playwright.fixtures.config.ts`.
  These fixtures do not prove call transport. The narrow-header echo-call test
  needs the isolated server and echo bot. Set `E2E_UI_FIXTURE_PORT` to a free
  dedicated port when another session runs UI fixtures. Call UI fixtures must
  assert the fail-closed error and keyboard dismissal when `canEncryptCalls()`
  is false. Do not bypass the encrypted-media capability guard. For calls across
  viewport sizes, use `conversationCall` from `web/e2e/support.ts`; narrow headers
  place call actions in the conversation menu.
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

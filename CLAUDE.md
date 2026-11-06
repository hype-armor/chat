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
- Quoted replies resolve originals only within their conversation in the worker
  and verify the encrypted content hash; outer envelope IDs are not authenticated.
  Typing indicators use encrypted, expiring events, not history or persistent retries
  (ADR-0038). Never include draft text in typing events.
- UI regression tests must cover native link selection, quoted replies, typing
  expiry, and scroll position during keyboard/media resize. Own sends reach the
  bottom; incoming messages must not displace a reader who scrolled up.
- Run browser tests against isolated test services, never a live deployment.
- For new or updated E2E composer selectors, use
  `getByRole('textbox', { name: 'Message', exact: true })`.
  Partial label matches also select Reply buttons once messages exist.
- E2E specs import `test` from `web/e2e/fixtures.ts`, not directly from
  `@playwright/test`. The fixture closes manually created client contexts
  after each test, including failures; the browser itself is worker-scoped.

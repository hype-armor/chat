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

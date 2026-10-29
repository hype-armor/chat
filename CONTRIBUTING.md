# Contributing

Thanks for helping. This project is licensed AGPL-3.0-or-later; by
contributing you agree your contributions are under the same licence.

## Before opening a pull request

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
DATABASE_URL=postgres://... cargo test --workspace   # needs PostgreSQL
scripts/build-wasm.sh && pnpm typecheck && pnpm test && pnpm build
pnpm --filter web e2e
```

CI runs the same checks plus end-to-end tests in Chromium, Firefox and
WebKit, and `helm lint`.

## Ground rules

- **No hand-rolled cryptography.** Use the audited libraries chosen in
  `docs/adr/`. Changes to crypto or protocol code need a second reviewer.
- **No plaintext on the server.** The server handles ciphertext and the
  minimum metadata listed in `docs/03-architecture.md` §6.
- **No third-party scripts, analytics or CDNs** in the web client; the CSP
  forbids them.
- Significant design changes go through a new ADR (`docs/adr/0000-template.md`).

## Reporting security issues

Please don't open a public issue. Email the maintainers privately
(a security contact and disclosure policy will be published before launch).

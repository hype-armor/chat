# chat

An end-to-end encrypted messenger with group chat, media, location sharing,
1:1 and group video calls, and an optional serverless mode over local
networks (and later Bluetooth / Wi-Fi). Web/PWA first, fully open source,
self-hostable.

**Status:** Phase 0 — scaffold and technical spikes. Not usable as a
messenger yet. Design docs: [`docs/`](docs/README.md).

## Repository layout

| Path | What |
|------|------|
| `proto/` | Protobuf wire format (envelopes, WebSocket frames) |
| `crates/chat-proto` | Rust types generated from `proto/` |
| `crates/chat-core` | Client core: MLS (OpenMLS), envelopes, padding. Builds natively and to WebAssembly |
| `crates/chat-server` | Server (Rust, axum): health checks, WebSocket endpoint, PostgreSQL migrations |
| `web/` | Web client / PWA (TypeScript, React, Vite); runs the core in a Web Worker |
| `deploy/docker` | Container images (server; web served by nginx with a strict CSP) |
| `deploy/compose` | Local development stack |
| `deploy/helm/chat` | Helm chart for Kubernetes |
| `deploy/k8s` | Cluster prerequisites (PostgreSQL, TLS, LiveKit) |
| `docs/` | Requirements, architecture, ADRs |

## Development

Prerequisites: Rust (via rustup; `rust-toolchain.toml` pins the toolchain and
the `wasm32-unknown-unknown` target), Node.js 24+, pnpm 10, and the
`wasm-bindgen` CLI at the version locked in `Cargo.lock`:

```sh
cargo install wasm-bindgen-cli --locked --version "$(scripts/wasm-bindgen-version.sh)"
```

```sh
cargo test --workspace          # core + server tests
scripts/build-wasm.sh           # core -> web/src/core/pkg
pnpm install
pnpm dev                        # web app at http://localhost:5173
cargo run -p chat-server        # server at http://localhost:8080 (no DB needed)
```

Web checks: `pnpm typecheck`, `pnpm test` (unit), `pnpm build`, then
`pnpm --filter web e2e` (Playwright; set `PW_ALL_BROWSERS=1` to include
Firefox and WebKit). The preview server applies the production security
headers from `deploy/docker/security-headers.inc.template`, so e2e tests
catch CSP regressions.

Full stack with PostgreSQL, Valkey, SeaweedFS (S3) and LiveKit:

```sh
docker compose -f deploy/compose/docker-compose.yml up --build
```

## Deployment

Production runs on self-hosted, single-node **k3s** in the US — follow
[`deploy/k3s/README.md`](deploy/k3s/README.md). Background and other
clusters: [docs/10-deployment-kubernetes.md](docs/10-deployment-kubernetes.md).

## Licence

Code: [GNU AGPL-3.0-or-later](LICENSE). Protocol specification: CC BY 4.0.

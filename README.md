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
| `crates/chat-server` | Server (Rust, axum): username sign-up with invites, key directory, authenticated WebSocket delivery queue ([API](docs/11-api.md)) |
| `web/` | Web client / PWA (TypeScript, React, Vite): sign-up, 1:1 chats; keys, storage and networking live in a Web Worker |
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
# Server tests need PostgreSQL; each test gets a fresh database.
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
cargo test --workspace          # core + server tests
scripts/build-wasm.sh           # core -> web/src/core/pkg
pnpm install
cargo run -p chat-server        # server at http://localhost:8080 (uses DATABASE_URL)
pnpm dev                        # web app at http://localhost:5173, proxies /v1 to :8080
```

Sign-up needs an invite unless the server runs with
`CHAT_REGISTRATION=open`. For development, set that, or create an invite
with `cargo run -p chat-server -- create-invite http://localhost:5173`.
Sign up in two browser profiles to chat with yourself.

Web checks: `pnpm typecheck`, `pnpm test` (unit), `pnpm build`, then
`pnpm --filter web e2e` (Playwright; set `PW_ALL_BROWSERS=1` to include
Firefox and WebKit, and `E2E_SERVER=1` with `DATABASE_URL` to run the
two-user messaging tests against a real server). The preview server applies the production security
headers from `deploy/docker/security-headers.inc.template`, so e2e tests
catch CSP regressions.

Full stack with PostgreSQL, Valkey, SeaweedFS (S3) and LiveKit:

```sh
docker compose -f deploy/compose/docker-compose.yml up --build
# first invite (sign-up is invite-only):
docker compose -f deploy/compose/docker-compose.yml exec server \
  chat-server create-invite http://localhost:8000
```

Open **http://localhost:8000 on the same machine**. Browsers enable the
encryption the app needs (WebCrypto) only on secure pages, so plain
`http://<server-ip>:8000` from another device shows a "must be opened over a
secure connection" page. For other devices, add the HTTPS front (Caddy with
its own certificate authority; browsers warn once):

```sh
CHAT_HOST=192.168.1.20 docker compose -f deploy/compose/docker-compose.yml --profile https up --build
# then open https://192.168.1.20:8443, and create invites for that address
```

## Deployment

Development and initial testing run on a self-hosted, single-node **k3s**
cluster: set it up with [`deploy/k3s/README.md`](deploy/k3s/README.md), then
deploy local code with `scripts/k3s-dev-deploy.sh`. The production host is
still open (self-hosted k3s or Linode). Background and other
clusters: [docs/10-deployment-kubernetes.md](docs/10-deployment-kubernetes.md).

## Licence

Code: [GNU AGPL-3.0-or-later](LICENSE). Protocol specification: CC BY 4.0.

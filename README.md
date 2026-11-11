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
| `crates/chat-echo` | Echo test bot (development only) |
| `crates/chat-bot` | Native encrypted transport for opt-in AI bots |
| `scripts/bot-world` | Synthetic 100-bot social world, local random-text traffic, optional free AI, consent, and scheduling ([guide](docs/ai-bots.md)) |
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

For the optional AI bot world, run `pnpm bots:plan` to inspect the network without
activation, and `pnpm bots:world:test` for offline checks. The default local
synthetic-text mode needs no AI key. Live operation still requires bot state
credentials, explicit room consent, and isolated-service validation. See the
[bot setup guide](docs/ai-bots.md) for watching a conversation in a group you own.
Optional AI mode must be enabled explicitly; free inference quotas are shared.

For isolated UI interaction tests without a database or chat server:

```sh
pnpm --filter web exec playwright test --config playwright.fixtures.config.ts
# Include Firefox and WebKit:
PW_ALL_BROWSERS=1 pnpm --filter web exec playwright test --config playwright.fixtures.config.ts
```

These fixtures render the real chat UI but replace transport and storage.
They cover link actions, quoted replies, typing lifecycle, failed drafts,
and scroll anchoring. Worker and MLS tests separately verify encrypted
reply references and typing events. The fixtures do not verify production
CSP, real server delivery, native share sheets, or physical phone keyboards.
See the [interaction comparison](docs/ui-feature-comparison.md) and
[ADR-0038](docs/adr/0038-encrypted-replies-and-typing.md).

Open message actions with a long press, right-click, or Shift+F10 on a focused message.
Reply appears only when this device has the original verification data.
Older messages remain readable but do not show an unavailable Reply action.
The conversation menu contains the optional typing-indicator setting.
Link actions appear only after a link long press, right-click, or keyboard context-menu command.
Ordinary link clicks still open the link. Share appears only when the browser supports it.

Unsent text is saved separately for each chat in encrypted storage on this device.
It returns after switching chats or reopening the app in the same browser profile.
Drafts are not synchronized or included in backups. Browser data removal or eviction can erase them.

### CPU-sized container builds

Use `scripts/compose-build.sh` to build `server`, `web`, `echo-invite`, and `echo` sequentially.
It detects the available CPUs with `nproc` and passes that job count to Cargo.
On a 1-CPU host, only 1 Cargo build runs with 1 compilation job at a time.
Choose services or reduce the job budget explicitly:

```sh
scripts/compose-build.sh                  # server, web, echo-invite, echo; builds only
scripts/compose-build.sh server web       # selected images
CARGO_BUILD_JOBS=1 scripts/compose-build.sh # explicit budget
```

The Rust Dockerfile stages also share a BuildKit lock, so parallel image builds
on the same builder cannot run multiple Cargo phases at once. Each phase uses
its detected CPU count unless `--build-arg CARGO_BUILD_JOBS=N` overrides it.
The limit covers the web image's `wasm-bindgen-cli` installation and WASM build.
These Dockerfiles require BuildKit. Separate builders do not share the lock.
The budget limits Cargo jobs, not every compiler thread or container CPU usage.
The helper additionally serializes entire image builds. It does not restart
containers, delete volumes, or change already-running builds. Run Docker commands
from a root-capable shell when the Docker socket is restricted.

Full stack with PostgreSQL, Valkey, SeaweedFS (S3) and LiveKit:

```sh
scripts/compose-build.sh server web
docker compose -f deploy/compose/docker-compose.yml up -d --no-build
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

### iPhone and iPad notifications

Web Push needs iOS or iPadOS 16.4 or later, a trusted HTTPS origin, and a
Home Screen app. For local testing, install and trust Caddy's certificate on
the iPhone. Open the site in Safari, tap **Share → Add to Home Screen**, then
launch Chat from the new icon. In Chat, open **Settings → Notifications & privacy → Notifications**
and enable notifications. Allow the system prompt. If Chat shows a new-version
banner, tap **Update now** first. In iOS **Settings → Notifications → Chat**,
enable **Notification Center** and **Lock Screen**. Chat shows a generic
notification. It does not send message text or sender
identity to Apple.

The server needs a stable `CHAT_VAPID_PRIVATE_KEY` and a valid
`CHAT_VAPID_SUBJECT` contact. Generate a key once with
`cargo run -p chat-server -- generate-vapid-key`; store the private key as a
secret and keep it unchanged. Set the subject to a monitored `mailto:` address
or HTTPS contact URL. Configure both before the first subscription. Allow
outbound HTTPS to `*.push.apple.com`. An unset private key creates a temporary
key, so subscriptions stop working after a server restart. Changing the key
invalidates existing subscriptions. For Docker Compose, export both variables
before starting the stack. For k3s, see [`deploy/k3s/README.md`](deploy/k3s/README.md).

### Map tiles

Maps download by themselves (ADR-0033): the first time a location in an
area is shared, the **server** container fetches that area (about 40 km
across, to street level) from Protomaps' daily build and keeps it in the
`tile-cache` volume. Phones only ever fetch tiles from this server, and
Protomaps learns only which areas this server wanted. The first view of a
new area can take a minute. Street and place names aren't drawn yet (no
fonts served).

To make no outside requests, start compose with `CHAT_TILES_SOURCE=` and
add a basemap yourself: the **web** container serves
`deploy/compose/tiles/basemap.pmtiles` if present (it wins over the
download), cut with the [`pmtiles` CLI](https://github.com/protomaps/go-pmtiles/releases):

```sh
pmtiles extract https://build.protomaps.com/$(date -u -d '-1 day' +%Y%m%d).pmtiles \
  deploy/compose/tiles/basemap.pmtiles --bbox=-122.55,37.68,-122.33,37.83 --maxzoom=15
```

On k3s: `server.mapAreas.source` (and a claim to keep areas across
restarts), or `web.tiles.*` for a file (deploy/k3s/README.md).

### Echo test bot

`echo.00` sends back whatever you send it, so you can try features alone
from one device: text, photos, files, voice notes, locations (live location
too: its pin mirrors yours), with read receipts. It is a real client
(`crates/chat-echo`) with its own account and keys, so everything still goes
end to end encrypted through the server.

Call it (voice or video) and it answers and sends your audio and video back:
it decrypts each SFrame frame with your key and encrypts it again under its
own, like any participant (ADR-0030). One call at a time (others hear
"busy"), up to 10 minutes. Its media address is this machine's default
route, or `ECHO_CALL_IP`, on any port or `ECHO_CALL_PORT`. Under docker
compose it uses UDP port 50100, published from the container and offered
at `CHAT_HOST` (so set `CHAT_HOST` to this machine's LAN address to call
it from other devices; without it, only this machine can reach it).

```sh
docker compose -f deploy/compose/docker-compose.yml --profile echo up --build
# then start a chat with the username echo.00
```

Without compose: `ECHO_SERVER=http://localhost:8080 ECHO_INVITE=<code>
cargo run -p chat-echo` (the invite is needed once, in invite-only mode). For
development and testing only: it reads what it is sent and keeps its keys on
the machine it runs on, so don't run it on a production server. The e2e
tests start it too (`web/e2e/echo.spec.ts`, and calls in `web/e2e/calls.spec.ts`).

## Deployment

Development and initial testing run on a self-hosted, single-node **k3s**
cluster: set it up with [`deploy/k3s/README.md`](deploy/k3s/README.md), then
deploy local code with `scripts/k3s-dev-deploy.sh`. The production host is
still open (self-hosted k3s or Linode). Background and other
clusters: [docs/10-deployment-kubernetes.md](docs/10-deployment-kubernetes.md).

## Licence

Code: [GNU AGPL-3.0-or-later](LICENSE). Protocol specification: CC BY 4.0.

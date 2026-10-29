# Web client (PWA) image. Build from the repository root:
#   docker build -f deploy/docker/web.Dockerfile -t chat-web .

# 1. Rust core -> WebAssembly
FROM rust:1.99-bookworm AS wasm
WORKDIR /src
COPY . .
RUN cargo install wasm-bindgen-cli --locked --version "$(scripts/wasm-bindgen-version.sh)" \
 && scripts/build-wasm.sh

# 2. TypeScript/React app
FROM node:24-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY web web
COPY deploy/docker/security-headers.inc.template deploy/docker/
COPY --from=wasm /src/web/src/core/pkg web/src/core/pkg
RUN pnpm --filter web build

# 3. Static files behind nginx with strict security headers
FROM nginxinc/nginx-unprivileged:1.31-alpine
COPY deploy/docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/docker/security-headers.inc.template /etc/nginx/templates/security-headers.inc.template
COPY --from=web /src/web/dist /usr/share/nginx/html
# Extra CSP connect-src origins, e.g. the LiveKit URL: "wss://rtc.example.com"
ENV CSP_CONNECT_EXTRA=""
EXPOSE 8080

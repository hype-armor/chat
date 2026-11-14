# Encrypted synthetic and opt-in AI bot runner. Build from the repository root:
#   docker build -f deploy/docker/bots.Dockerfile -t chat-bots .
FROM rust:1.99-bookworm AS build
WORKDIR /src
COPY . .
ARG CARGO_BUILD_JOBS
# One CPU-sized Cargo build at a time, even when Compose builds images in parallel.
RUN --mount=type=cache,id=chat-cargo-build-slot,target=/var/lock/chat-cargo-build,sharing=locked \
    export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-$(nproc)}" \
 && cargo build --release --locked -p chat-bot

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/chat
# The runtime contains only the native worker and offline coordinator inputs.
COPY --from=build /src/target/release/chat-bot /opt/chat/bin/chat-bot
COPY --from=build /src/scripts/bot-world /opt/chat/scripts/bot-world
COPY --from=build /src/fixtures/bot-world /opt/chat/fixtures/bot-world
USER node

# Encrypted synthetic and opt-in AI bot runner. Build from the repository root:
#   docker build -f deploy/docker/bots.Dockerfile -t chat-bots .
FROM rust:1.99-bookworm AS build
WORKDIR /src
COPY . .
ARG CARGO_BUILD_JOBS
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
# One CPU-sized Cargo build at a time, even when Compose builds images in parallel.
RUN --mount=type=cache,id=chat-cargo-build-slot,target=/var/lock/chat-cargo-build,sharing=locked \
    --mount=type=cache,id=chat-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=chat-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=chat-cargo-target-rust1.99-bookworm-${TARGETOS}-${TARGETARCH}-${TARGETVARIANT},target=/src/target,sharing=locked \
    export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-$(nproc)}" CARGO_TARGET_DIR=/src/target \
 && cargo build --release --locked -p chat-bot \
 && mkdir -p /out && cp /src/target/release/chat-bot /out/

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/chat
# The runtime contains only the native worker and offline coordinator inputs.
COPY --from=build /out/chat-bot /opt/chat/bin/chat-bot
COPY --from=build /src/scripts/bot-world /opt/chat/scripts/bot-world
COPY --from=build /src/fixtures/bot-world /opt/chat/fixtures/bot-world
USER node

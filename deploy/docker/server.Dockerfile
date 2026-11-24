# Chat server image. Build from the repository root:
#   docker build -f deploy/docker/server.Dockerfile -t chat-server .
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
 && cargo build --release --locked -p chat-server \
 && mkdir -p /out/tile-cache \
 && cp /src/target/release/chat-server /src/target/release/chat-admin /out/

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/chat-server /usr/local/bin/chat-server
COPY --from=build /out/chat-admin /usr/local/bin/chat-admin
# Map areas downloaded on demand (CHAT_TILES_DIR); a volume in practice.
COPY --from=build --chown=nonroot:nonroot /out/tile-cache /srv/tile-cache
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/chat-server"]

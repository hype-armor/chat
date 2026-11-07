# Chat server image. Build from the repository root:
#   docker build -f deploy/docker/server.Dockerfile -t chat-server .
FROM rust:1.99-bookworm AS build
WORKDIR /src
COPY . .
ARG CARGO_BUILD_JOBS
# One CPU-sized Cargo build at a time, even when Compose builds images in parallel.
RUN --mount=type=cache,id=chat-cargo-build-slot,target=/var/lock/chat-cargo-build,sharing=locked \
    export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-$(nproc)}" \
 && cargo build --release --locked -p chat-server && mkdir -p /out/tile-cache

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/chat-server /usr/local/bin/chat-server
# Map areas downloaded on demand (CHAT_TILES_DIR); a volume in practice.
COPY --from=build --chown=nonroot:nonroot /out/tile-cache /srv/tile-cache
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/chat-server"]

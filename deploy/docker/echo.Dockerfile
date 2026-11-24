# Echo test bot image (development and testing only). Build from the
# repository root:
#   docker build -f deploy/docker/echo.Dockerfile -t chat-echo .
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
 && cargo build --release --locked -p chat-echo \
 && mkdir -p /out && cp /src/target/release/chat-echo /out/

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/chat-echo /usr/local/bin/chat-echo
USER nonroot
ENTRYPOINT ["/usr/local/bin/chat-echo"]

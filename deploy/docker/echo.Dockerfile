# Echo test bot image (development and testing only). Build from the
# repository root:
#   docker build -f deploy/docker/echo.Dockerfile -t chat-echo .
FROM rust:1.99-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p chat-echo

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/chat-echo /usr/local/bin/chat-echo
USER nonroot
ENTRYPOINT ["/usr/local/bin/chat-echo"]

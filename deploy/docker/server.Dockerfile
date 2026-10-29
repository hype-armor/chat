# Chat server image. Build from the repository root:
#   docker build -f deploy/docker/server.Dockerfile -t chat-server .
FROM rust:1.99-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p chat-server

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/chat-server /usr/local/bin/chat-server
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/chat-server"]

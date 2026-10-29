# Performance: delivery latency

**Status:** Draft. Measured 2026-10-29 (Phase 1 checklist item 7).

Target: **NFR-PERF-1**, message delivery p95 < 1 s when both parties are
online.

## Method

`crates/chat-server/examples/loadtest.rs` starts the server in-process
against a real PostgreSQL and drives it over real WebSockets:

1. Register *N* users and put them in groups of *G*. The test inserts
   group membership directly; MLS runs on clients and costs the server
   nothing.
2. Connect everyone, then each user sends a 256-byte padded envelope to
   the rest of its group at a steady rate.
3. Each envelope carries its send time. Receivers record send-to-receive
   latency and ack, like the web client.

```sh
createdb chat_load   # throwaway: the test leaves its users behind
DATABASE_URL=postgres://.../chat_load cargo run --release -p chat-server \
  --example loadtest -- --users 200 --group-size 5 --rate 1 --seconds 30
```

It exits non-zero if p95 is 1 s or more. The latency excludes client-side
MLS encryption and decryption (milliseconds per message, and NFR-PERF-5
for group changes) and the network between phone and server.

## Results

One 4-vCPU VM (Xeon 2.8 GHz), PostgreSQL 16, release build. Load
generator, server and database all share the 4 vCPUs, so these numbers
are pessimistic.

| Users | Group size | Rate per user | Deliveries/s | p50 | p95 | p99 |
|------:|-----------:|--------------:|-------------:|----:|----:|----:|
| 200 | 5 | 1/s | 800 | 3 ms | 16 ms | 42 ms |
| 500 | 50 | 0.1/s | 2 450 | 15 ms | 50 ms | 73 ms |
| 700 | 5 | 1/s | 2 800 | 205 ms | 486 ms | 599 ms |
| 500 | 50 | 0.2/s | 4 900 | 0.8–1.1 s | 2.0–2.3 s | 2.4–2.7 s |

For scale, 100 users (the launch) chatting actively, at 1 message a
minute each to groups of 5, is about 7 deliveries/s. The target holds up to
about 2 800 deliveries/s on this machine; above that the CPU saturates.
The first things to do when real traffic gets there:
- batch acks (one `DELETE` per delivery today);
- use a dedicated database node.

The load test found a real bug, fixed in the same change. Concurrent sends
to one device could commit out of `queue_id` order, and the connection's
queue cursor then skipped the earlier one until the next reconnect.
`delivery::send` now locks the recipients' device rows, in a fixed order,
until commit.

## Server metrics

The server exposes Prometheus metrics on `CHAT_METRICS_BIND` (default
`0.0.0.0:9090`, Helm `server.metrics`). That port is not routed by the
ingress; the NetworkPolicy admits only the `monitoring` namespace. The
metrics are aggregates only, with no per-device, per-account or
per-conversation labels:

| Metric | Meaning |
|--------|---------|
| `chat_delivery_seconds` | Queue to socket for envelopes delivered to a connected device (the server's share of NFR-PERF-1) |
| `chat_send_seconds` | Time to handle a WebSocket send: checks, queueing, wake-ups |
| `chat_send_errors_total{code}` | Refused sends by status code |
| `chat_websocket_connections` | Authenticated WebSocket connections |

p95 on the dev cluster:
`histogram_quantile(0.95, rate(chat_delivery_seconds_bucket[5m]))`.

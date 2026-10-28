# 08 — Technology Options

**Status:** Draft — options and leanings only. Each row maps to an ADR that
must be accepted before implementation.

## 0. Evaluation criteria

Weighted, in order: **security & auditability**, **cross-platform reuse**
(one implementation of security-critical code), **maturity of required
libraries**, **team skills/hiring**, **operational cost**, **licensing**.

## 1. Build from scratch vs. build on an existing protocol (ADR-0001)

| Option | Pros | Cons |
|--------|------|------|
| **Own protocol stack on standard building blocks (MLS, WebRTC, SFrame)** | Full control over UX, metadata, offline mode | Most work; we own the security burden |
| Matrix (Synapse/Dendrite/Conduit + matrix-rust-sdk) | Federation, mature SDK, MLS migration under way | Server holds lots of metadata by design; heavy; offline mesh not native |
| Fork Signal (server + apps) | Battle-tested | AGPL; centralised; no offline mesh; heavy to diverge from |
| XMTP / SimpleX / Berty | Interesting privacy/offline properties | Smaller ecosystems; differing goals |

**Leaning:** own stack on standard building blocks, reusing Matrix/Signal/
Briar designs as references. Offline mesh + MLS + metadata minimisation is
not well served by any existing system.

## 2. Client (ADR-0003, ADR-0004)

### Shared core library
| Option | Notes |
|--------|------|
| **Rust core + UniFFI bindings** | Memory-safe; OpenMLS, vodozemac, libsignal, rustls, SQLCipher bindings all in Rust; used by Signal, Matrix, Firefox, 1Password. **Leaning.** |
| Kotlin Multiplatform | Good for Android teams; weaker crypto ecosystem on iOS |
| C++ | Max portability; memory-safety risk in parsers |

### UI layer
| Option | Pros | Cons |
|--------|------|------|
| **Native (SwiftUI + Jetpack Compose)** | Best CallKit/BLE/background integration, best feel | Two UI codebases |
| Flutter | One UI codebase, good performance | Platform channels for BLE/CallKit/WebRTC; FFI to Rust fine (flutter_rust_bridge) |
| React Native | Large talent pool | Same native-module burden; WebRTC/BLE plugins vary in quality |

**Leaning:** Rust core + native UI if team has both iOS & Android
skills; otherwise Rust core + Flutter. Offline mode and calling are the
most platform-specific parts either way.

### Media engine
libwebrtc (Google) via platform SDKs, or LiveKit client SDKs (wrap
libwebrtc), with SFrame via encoded transforms.

## 3. Server (ADR-0005)

| Concern | Options | Leaning |
|---------|---------|---------|
| Language | Rust, Go, Elixir/Erlang (BEAM excels at millions of connections), Kotlin/JVM | Rust (shared types with core) or Go; Elixir if team has it |
| Client transport | WebSocket over TLS 1.3; QUIC/HTTP3 (better on mobile handover); gRPC streaming | WebSocket now, QUIC later |
| Serialisation | Protocol Buffers, Cap'n Proto, CBOR | Protobuf |
| Queue/message store | Cassandra/ScyllaDB, FoundationDB, PostgreSQL (partitioned), Redis Streams | PostgreSQL for MVP; ScyllaDB/FDB at scale |
| Accounts/keys DB | PostgreSQL | PostgreSQL |
| Ephemeral state / presence | Redis / Valkey, NATS | Valkey |
| Inter-service bus | NATS, Kafka | NATS |
| Blob storage | S3-compatible (AWS S3, R2, MinIO) + CDN | S3-compatible |
| Push | APNs, FCM (direct); UnifiedPush for de-Googled Android (C) | Direct |
| Deploy | Kubernetes, Nomad, managed containers | Kubernetes or managed containers |

## 4. Real-time media servers (ADR-0006)

| Option | Lang | Notes |
|--------|------|------|
| **LiveKit** | Go (Pion) | Full stack, SDKs for all platforms, E2EE hooks, Apache-2.0. **Leaning.** |
| mediasoup | C++/Node | Very efficient, lower-level; more to build |
| Janus | C | Mature, plugin-based |
| Jitsi Videobridge | Java | Mature; E2EE via insertable streams |
| coturn / eturnal | C / Erlang | TURN servers |

## 5. Cryptography libraries (ADR-0002)

| Need | Candidate |
|------|-----------|
| Group/1:1 E2EE | **OpenMLS** (Rust, MIT); alternative libsignal (AGPL) |
| Link layer (offline) | Noise via `snow` (Rust) |
| Primitives | RustCrypto / ring / aws-lc-rs; libsodium |
| Media E2EE | SFrame implementation (e.g., `sframe` crate, or LiveKit's) |
| Local DB | SQLCipher, or SQLite + app-level AEAD |
| Key transparency | Akd (Meta, Rust) / IETF KEYTRANS drafts |

## 6. Offline transports (ADR-0007)
Native per platform (CoreBluetooth, Android BLE, Wi-Fi Aware/Direct,
Multipeer); protocol logic in the Rust core. Prototype first — see doc 07.

## 7. Maps (ADR-0008)
MapLibre (open source, works with OSM vector tiles, offline packs) +
self-hosted/proxied tiles.

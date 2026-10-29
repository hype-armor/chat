# 08 — Technology Stack

**Status:** Decided (2026-10-28), open to review. You asked for the
best-fitting tools with no restrictions, so each choice below is recorded
as an ADR in [`adr/`](adr/) with the alternatives that were rejected.

Criteria, in order: **security & auditability → works in every browser →
one implementation of security-critical code across web and later native →
library maturity → self-hostability → open-source licence compatibility →
cost to operate**.

## Summary

| Layer | Choice | ADR |
|-------|--------|-----|
| Approach | Own stack on standard building blocks (MLS, WebRTC, SFrame, Web Push) | 0001 |
| E2EE | MLS (RFC 9420) via **OpenMLS**, PQ-hybrid ciphersuite when available | 0002 |
| Client core | **Rust → WebAssembly** (wasm-bindgen), running in a Web Worker | 0003 |
| Client UI | **TypeScript + React + Vite**, custom service worker, installable PWA | 0004 |
| Local storage | **SQLite WASM on OPFS**, page-encrypted; key wrapped by non-extractable WebCrypto key | 0003 |
| Server | **Rust** (tokio + axum) modular monolith; WebSocket; Protobuf | 0005 |
| Datastores | **PostgreSQL** (accounts, keys, queues), **Valkey** (presence, rate limits), **S3-compatible** blobs (SeaweedFS when self-hosted) | 0005 |
| Push | **Web Push** (VAPID, RFC 8291) | 0005 |
| Calls | **LiveKit** SFU + **coturn** TURN; **SFrame** keyed from MLS | 0006 |
| Offline | Tier 1: WebRTC over local network + QR pairing; Tier 2: native BLE / Wi-Fi Aware plugins | 0007 |
| Maps | **MapLibre GL JS + Protomaps PMTiles** (self-hosted OSM tiles) | 0008 |
| Federation | Not in v1; self-hosting in v1 | 0009 |
| Backup | Encrypted backup with user-held recovery key | 0010 |
| Identity | Phone number + SMS/voice one-time code via pluggable provider | 0011 |
| Licence | AGPL-3.0-or-later for code; CC BY 4.0 for the protocol spec | 0012 |
| Runtime / hosting | **Kubernetes** in a **US** region; CloudNativePG, cert-manager, LiveKit chart | 0014 |
| Native wrappers (later) | **Capacitor** (Android/iOS), **Tauri** (desktop), reusing the web UI and core | 0013 |

## Why these fit

### Rust → WASM core
- OpenMLS, RustCrypto, prost (Protobuf) and snow (Noise) all compile to
  WASM, so one audited core runs in browsers now and in native wrappers
  later.
- Memory safety for every parser that handles untrusted input (envelopes,
  mesh packets, QR payloads).
- The server is Rust too, so envelope/protocol types are shared and can't
  drift.

### TypeScript + React
- Largest contributor pool, which matters for a fully open project.
- Mature WebRTC, MapLibre and accessibility ecosystem.
- Bundle-size budget (NFR-PERF-6): code-split calls, maps and media
  editors; the WASM core is loaded once and cached.

### Rust server as a modular monolith
- At launch scale (100 users, groups ≤ 50) one binary with clear internal modules
  (gateway, accounts, keys, delivery, blobs, push, signalling) is simpler
  to run and to self-host. Modules split into services only if load
  demands it.
- PostgreSQL is enough for the delivery queue at this scale (partitioned
  table + `SKIP LOCKED`); a move to ScyllaDB/FoundationDB is a later
  option, not a v1 need.

### LiveKit
- Apache-2.0, self-hostable, browser SDK, simulcast/SVC, built-in TURN
  integration, and a supported path for custom frame encryption. 50-person
  calls are well within range.

### MapLibre + PMTiles
- Fully open; one static file served over HTTP range requests (works from
  our server, a CDN, or a self-hoster's S3); regions can be cached in OPFS
  for offline use. No third party sees which coordinates users view.

## Tooling

| Need | Choice |
|------|--------|
| Monorepo | Cargo workspace + pnpm workspace |
| Wire format | Protobuf (prost / ts-proto) |
| QR scanning | `BarcodeDetector` where available, else zxing-wasm |
| Testing | `cargo test`, Vitest, **Playwright** for multi-browser end-to-end tests (Chromium, Firefox, WebKit), cargo-fuzz for parsers |
| Reproducible builds | Pinned toolchains + Nix flake; release hashes published to a transparency log (Sigstore) |
| CI | GitHub Actions |
| Deployment | Kubernetes + Helm chart (production, ADR-0014); Docker Compose for local development |

# ADR-0001: Build our own stack on standard building blocks

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** FR-OFF-*, NFR-SEC-3

## Context
We need E2EE everywhere, web-first delivery, offline/mesh mode with strangers, and minimal metadata. No existing system offers all of these.

## Options considered
1. **Own stack on MLS + WebRTC + SFrame + Web Push**: full control over metadata and offline mode; we carry the integration risk.
2. **Matrix** (matrix-rust-sdk, Synapse/Conduit): mature, has a WASM SDK; but the server is metadata-heavy by design and has no offline mesh.
3. **Fork Signal**: battle-tested, but no web client, centralised, no mesh.
4. **Berty / SimpleX / XMTP**: interesting privacy properties; no web-first client, smaller ecosystems.

## Decision
Build our own stack from standard, audited building blocks. Use Matrix, Signal, Briar and Berty as design references.

## Consequences
We own protocol integration and must fund an external audit. We gain a single envelope format across server, LAN, and radio transports.

## Validation
Phase 0 spikes succeed (MLS in WASM, QR-paired WebRTC, SFrame via LiveKit).

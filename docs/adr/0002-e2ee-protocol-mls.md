# ADR-0002: E2EE protocol: MLS via OpenMLS

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** NFR-SEC-1/2/4, FR-MSG-3

## Context
We need E2EE for 1:1 and groups of up to 50, running in browsers, with keys we can export for call encryption.

## Options considered
1. **MLS / OpenMLS**: IETF standard, MIT licence, compiles to WASM, exporter secrets for calls, strong group post-compromise security. Needs commits ordered by a server.
2. **Signal Protocol / libsignal**: excellent and AGPL is now acceptable, but there is no supported WASM/browser build, and Sender Keys has weaker group PCS.
3. **Olm/Megolm / vodozemac**: WASM available, but weaker group security, and Matrix itself is moving to MLS.

## Decision
MLS for every conversation (1:1 = 2-member group) using OpenMLS. Switch to an X-Wing / ML-KEM hybrid ciphersuite once OpenMLS ships one. Offline: membership is frozen (ADR-0007).

## Consequences
One code path for all conversations. The Delivery Service must order commits per group. Offline mode cannot change membership.

## Validation
OpenMLS WASM benchmark: a 50-member commit takes < 200 ms on a mid-range phone browser (NFR-PERF-5).

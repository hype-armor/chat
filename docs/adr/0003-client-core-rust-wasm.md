# ADR-0003: Client core in Rust compiled to WebAssembly

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** NFR-SEC-3, FR-PLAT-*

## Context
Security-critical logic (crypto, envelope parsing, storage, mesh routing) must be written once and run in browsers now and in native wrappers later.

## Options considered
1. **Rust → WASM in a Web Worker**: memory-safe, OpenMLS is native Rust, the same crate builds natively later.
2. **TypeScript-only core**: simpler build; no mature MLS library; parsers would be less safe.
3. **C++ → WASM (MLS++)**: workable, but memory-safety risk.

## Decision
Rust core built with wasm-bindgen, running in a dedicated worker (a SharedWorker where supported, so multiple tabs share one core). Local DB: official SQLite WASM build on the OPFS SyncAccessHandle VFS with page encryption (SQLite3MultipleCiphers); the DB key is wrapped by a non-extractable WebCrypto key.

## Consequences
WASM bundle size must be watched (target < 1 MB compressed). Multi-tab coordination is needed where SharedWorker is missing (Web Locks API leader election).

## Validation
Spike: SQLite3MultipleCiphers on OPFS in Safari, Firefox and Chrome; WASM size budget met.

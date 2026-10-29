# Architecture Decision Records

Format: one file per decision, `NNNN-short-title.md`, using
[`0000-template.md`](0000-template.md). Status: `Proposed` → `Accepted` /
`Rejected` / `Superseded by NNNN`. Accepted decisions can still be
revisited; do it with a new ADR that supersedes the old one.

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-build-own-stack.md) | Build our own stack on standard building blocks | Accepted |
| [0002](0002-e2ee-protocol-mls.md) | E2EE protocol: MLS via OpenMLS | Accepted |
| [0003](0003-client-core-rust-wasm.md) | Client core in Rust compiled to WebAssembly | Accepted |
| [0004](0004-client-ui-typescript-react.md) | Client UI: TypeScript + React + Vite PWA | Accepted |
| [0005](0005-server-stack.md) | Server: Rust modular monolith, PostgreSQL, Valkey, S3, Web Push | Accepted |
| [0006](0006-calls-livekit-sframe.md) | Calls: LiveKit SFU + coturn, SFrame keyed from MLS | Accepted |
| [0007](0007-offline-two-tier.md) | Offline mode: WebRTC local mode (web) + radio mesh (native) | Accepted |
| [0008](0008-maps-maplibre-pmtiles.md) | Maps: MapLibre GL JS + Protomaps PMTiles | Accepted |
| [0009](0009-federation-later.md) | No federation in v1; self-hosting supported | Accepted |
| [0010](0010-backup-recovery-key.md) | Encrypted backup with user-held recovery key | Accepted |
| [0011](0011-identity-phone-number.md) | Account identity: phone number | Accepted |
| [0012](0012-licence.md) | Licence: AGPL-3.0-or-later (code), CC BY 4.0 (spec) | Accepted |
| [0013](0013-native-wrappers.md) | Native wrappers: Capacitor (mobile), Tauri (desktop) | Accepted |

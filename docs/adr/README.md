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
| [0011](0011-identity-phone-number.md) | Account identity: phone number | Superseded by 0021 |
| [0012](0012-licence.md) | Licence: AGPL-3.0-or-later (code), CC BY 4.0 (spec) | Accepted |
| [0013](0013-native-wrappers.md) | Native wrappers: Capacitor (mobile), Tauri (desktop) | Accepted |
| [0014](0014-kubernetes-us-hosting.md) | Run on Kubernetes, hosted in the United States | Accepted |
| [0015](0015-self-hosted-k3s.md) | Self-host on single-node k3s | Accepted |
| [0016](0016-group-roles-and-leaving.md) | Group roles, removal and leaving (v1) | Accepted |
| [0017](0017-send-authorisation.md) | Send authorisation by conversation membership | Accepted |
| [0018](0018-pull-based-dev-deployment.md) | Pull-based continuous deployment to the dev cluster | Accepted |
| [0019](0019-linked-devices.md) | Linked devices: server-approved link codes, MLS for everything else | Accepted |
| [0020](0020-safety-numbers.md) | Safety numbers per pair of accounts; warnings on new device keys | Accepted |
| [0021](0021-usernames-and-invites.md) | Usernames and invite-only sign-up (replaces phone numbers) | Accepted |
| [0022](0022-backup-and-restore.md) | Backup of history under a recovery key; restore as a new device that members re-add | Accepted |
| [0023](0023-blob-transfer-through-server.md) | Attachments stream through the server (not pre-signed URLs) | Accepted |
| [0024](0024-attachment-encryption.md) | Attachments sealed with STREAM over AES-256-GCM in the core; photos re-drawn to drop metadata | Accepted |
| [0025](0025-resumable-transfers.md) | Resumable uploads in parts, ranged downloads, auto-download settings | Accepted |
| [0026](0026-location-and-map-tiles.md) | One-shot locations; PMTiles served by the web pod, read through the core worker | Accepted |
| [0027](0027-live-location.md) | Live location as ordinary messages; receivers keep only the latest point | Accepted |
| [0028](0028-call-signalling.md) | 1:1 call signalling as MLS messages, media peer to peer | Accepted |

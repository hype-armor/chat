# Architecture Decision Records

Format: one file per decision, `NNNN-short-title.md`, using
[`0000-template.md`](0000-template.md). Status: `Proposed` → `Accepted` /
`Rejected` / `Superseded by NNNN`.

| ADR | Decision | Status | Leaning (see doc 08) |
|-----|----------|--------|----------------------|
| 0001 | Build own stack vs. build on Matrix/Signal/other | Open | Own stack on standard building blocks |
| 0002 | E2EE protocol & library | Open | MLS via OpenMLS, PQ hybrid when available |
| 0003 | Shared client core language | Open | Rust + UniFFI |
| 0004 | Client UI framework | Open | Native or Flutter — depends on team |
| 0005 | Server language, transport & datastores | Open | Rust/Go, WebSocket, PostgreSQL, Valkey, S3 |
| 0006 | Media server (SFU/TURN) | Open | LiveKit + coturn |
| 0007 | Offline transports & mesh protocol | Open | BLE baseline + Wi-Fi upgrade; spike first |
| 0008 | Maps & tile provider | Open | MapLibre + proxied OSM tiles |
| 0009 | Federation / self-hosting | Open | Not in v1 |
| 0010 | Backup & recovery | Open | Device transfer only in v1 |
| 0011 | Account identifier | Open | Username, optional phone |

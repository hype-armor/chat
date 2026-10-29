# 09 — Roadmap & Open Questions

**Status:** Draft

## 1. Stakeholder decisions (2026-10-28)

| Question | Answer | Where applied |
|----------|--------|---------------|
| Platforms | Web + PWA first | 01, 03, ADR-0004, ADR-0013 |
| Identity | Phone number | 02 FR-ID-1, ADR-0011 |
| Max group size | 50 (chat and calls) | 02 FR-MSG-3, FR-CALL-2 |
| Offline scope | Contacts **and strangers** | 07 §3.3, FR-OFF-10..12 |
| Technology | No restrictions — best fit | 08, ADRs 0001–0013 |
| Openness | Fully open source, self-hostable | 01, NFR-SEC-8 |
| Licence (2026-10-29) | AGPL-3.0-or-later (code), CC BY 4.0 (spec) | ADR-0012, `LICENSE` |
| Retention (2026-10-29) | 30 days for undelivered messages and attachments | 02 FR-MSG-9, 05 §1 |
| Attachment limit (2026-10-29) | 100 MB | 02 FR-MED-3 |
| Launch scale (2026-10-29) | 100 users | 02 NFR-SCALE-1, §5 below |

## 2. Phased roadmap

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| **0. Spikes** | (a) OpenMLS in WASM in all 3 browser engines, 50-member commit timing; (b) SQLite3MultipleCiphers on OPFS; (c) QR-paired WebRTC on a phone hotspot with no internet (iOS Safari PWA + Android Chrome), third peer joining via the mesh; (d) SFrame-encrypted 3-party call through LiveKit | All four demoed; ADRs confirmed or superseded |
| **1. MVP messaging (web)** | Phone sign-up, device keys, 1:1 + groups (MLS), Web Push, encrypted local DB, PWA install, device linking by QR | Internal dogfood; delivery p95 < 1 s |
| **2. Media, location, backup** | Encrypted attachments, voice notes, one-shot + live location (foreground), encrypted backup | Feature-complete beta |
| **3. Calling** | 1:1 P2P calls, then group calls via LiveKit with SFrame | Call success ≥ 99% |
| **4. Local mode (Tier 1 offline)** | QR rooms, contacts + strangers, mesh relay, local calls, sync back online | Field test with 20+ devices |
| **5. Hardening & public launch** | Release transparency log + update gate, reproducible builds, key transparency, external audit, self-host package, bug bounty | Audit findings closed |
| **6. Native wrappers & radio mesh (Tier 2)** | Capacitor Android/iOS + Tauri desktop; BLE / Wi-Fi Aware mesh; CallKit/Telecom ringing; background location | Field test with 100+ devices |
| Later | Federation (MIMI), LoRa hardware bridge | — |

## 3. Top risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Web code delivery: a compromised server ships malicious JS to a target | High | Doc 04 §9: reproducible builds, transparency log, service-worker update gate, native wrappers for high-risk users |
| Browser storage eviction loses keys/history | High | Persistent storage request, install prompt, linked devices, encrypted backup |
| Hotspot/LAN quirks break QR-paired WebRTC (client isolation, mDNS) | High | Phase 0 spike (c); fallback: the hotspot host relays for others |
| No background execution on web (missed calls, live location pauses) | Medium | Honest UX; native wrappers in phase 6 |
| Stranger spam/abuse offline (no phone verification) | Medium | Doc 07 §8 |
| SMS-pumping fraud and SMS cost | Medium | Rate limits, CAPTCHA/proof-of-work before sending codes, blocking premium-rate number ranges |
| MLS ordering vs. offline | Medium | Membership frozen offline (ADR-0007) |
| iOS Safari gaps (Web Push needs an installed PWA, WebRTC/encoded-transform quirks) | Medium | Feature detection; test in WebKit on every PR (Playwright) |

## 4. Remaining open questions

1. **Hosting & jurisdiction** for the main instance (undecided). §5 lists
   what launch needs; any VPS provider or cloud account will do.
2. **Funding**: covers SMS costs, hosting, and the external security audit
   (the audit is the largest single cost).
3. **Moderation stance**: no client-side scanning (current position); is
   user reports + message franking enough?

## 5. Launch deployment (100 users)

At 100 users the whole stack fits on **one modest server**, so hosting can
stay undecided until Phase 1 without blocking work:

| Item | Launch sizing |
|------|---------------|
| Server | One VM, ~4 vCPU / 8 GB RAM, running everything via Docker Compose (Rust server, PostgreSQL, Valkey, MinIO, LiveKit, coturn) |
| Storage | ~100 GB disk is ample: 100 users × 30-day attachment retention, plus a regional map extract (a full planet tile file is ~100 GB, so start with the regions we need) |
| Bandwidth | Dominated by group calls and TURN relays; a provider with generous included egress matters more than CPU |
| Network | Public IPv4, UDP ports open for WebRTC/TURN, a domain with HTTPS |
| Backups | Nightly PostgreSQL dump to separate storage (holds only ciphertext + account data) |
| SMS | Any provider behind the pluggable interface; at 100 users cost is negligible |

What to weigh when choosing a host: jurisdiction (legal requests can only
get metadata, but less is better), UDP support, egress pricing, and
whether self-hosters can copy the setup easily.

## 6. Assumptions register (still to confirm)

| Doc | Assumption |
|-----|------------|
| 04 | No client-side content scanning |
| 05 | Max 16 video tiles visible in a 50-person call |
| 07 | Mesh hop limit 7, TTL 24 h, 50 MB relay quota, ≤ 8 direct peers per device |

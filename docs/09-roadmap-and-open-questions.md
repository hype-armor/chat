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
| Runtime (2026-10-29) | Kubernetes | ADR-0014, doc 10 |
| Hosting (2026-10-29) | United States | ADR-0014, doc 10 §6 |
| Cluster (2026-10-29) | Self-hosted single-node k3s for development and initial testing; production host open (Linode kept as an option) | ADR-0015, deploy/k3s |
| Remaining placeholders (2026-10-29) | Confirmed: no content scanning, 16 video tiles, mesh limits (7 hops, 24 h, 50 MB, 8 peers) | 04, 05, 07 |

## 2. Phased roadmap

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| **0. Spikes** | Scaffold in place (see repo README). (a) OpenMLS in WASM in all 3 browser engines, 50-member commit timing — *Chromium done: 17 ms on desktop*; (b) SQLite3MultipleCiphers on OPFS; (c) QR-paired WebRTC on a phone hotspot with no internet (iOS Safari PWA + Android Chrome), third peer joining via the mesh; (d) SFrame-encrypted 3-party call through LiveKit | All four demoed; ADRs confirmed or superseded |
| **1. MVP messaging (web)** | *In progress: server delivery, web sign-up and 1:1 chat done.* Deployed continuously to the dev k3s cluster. Phone sign-up, device keys, 1:1 + groups (MLS), Web Push, encrypted local DB, PWA install, device linking by QR | Internal dogfood; delivery p95 < 1 s |
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

1. **Production host**: self-hosted k3s vs. Linode (doc 10 §2). Needed
   before real users; development and testing proceed on self-hosted k3s.
2. **Off-site backup target** (an S3-compatible bucket in another
   location).
3. **Funding**: covers SMS costs, hosting, and the external security audit
   (the audit is the largest single cost).

## 5. Launch deployment (100 users)

At 100 users the whole stack fits on **one modest server**, so hosting can
stay undecided until Phase 1 without blocking work:

| Item | Launch sizing |
|------|---------------|
| Cluster | One k3s node, ~4 vCPU / 8 GB RAM / 100 GB+ SSD, in the US, running everything (doc 10, deploy/k3s) |
| Storage | ~100 GB disk is ample: 100 users × 30-day attachment retention, plus a regional map extract (a full planet tile file is ~100 GB, so start with the regions we need) |
| Bandwidth | Dominated by group calls and TURN relays; a provider with generous included egress matters more than CPU |
| Network | Public IPv4, UDP ports open for WebRTC/TURN, a domain with HTTPS |
| Backups | CloudNativePG base backups + WAL archiving to object storage (holds only ciphertext + account data) |
| SMS | Any provider behind the pluggable interface; at 100 users cost is negligible |

Choosing where the k3s host runs: UDP reachability, upload bandwidth and
a static IP matter most (doc 10 §2.0).

## 6. Assumptions register

All placeholders were confirmed on 2026-10-29; none remain open.

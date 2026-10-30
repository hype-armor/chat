# 09 — Roadmap & Open Questions

**Status:** Draft

## 1. Stakeholder decisions (2026-10-28)

| Question | Answer | Where applied |
|----------|--------|---------------|
| Platforms | Web + PWA first | 01, 03, ADR-0004, ADR-0013 |
| Identity | Username + invite-only sign-up (was phone number) | 02 FR-ID-1, ADR-0021 |
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
| **1. MVP messaging (web)** | *In progress: server delivery, web sign-up, 1:1 chats and groups (create, add people) done.* Deployed continuously to the dev k3s cluster. Username sign-up by invite, device keys, 1:1 + groups (MLS), Web Push, encrypted local DB, PWA install, device linking by QR | Internal dogfood; delivery p95 < 1 s |
| **2. Media, location, backup** | Encrypted attachments, voice notes, one-shot + live location (foreground), encrypted backup | Feature-complete beta |
| **3. Calling** | 1:1 P2P calls, then group calls via LiveKit with SFrame | Call success ≥ 99% |
| **4. Local mode (Tier 1 offline)** | QR rooms, contacts + strangers, mesh relay, local calls, sync back online | Field test with 20+ devices |
| **5. Hardening & public launch** | Release transparency log + update gate, reproducible builds, key transparency, external audit, self-host package, bug bounty | Audit findings closed |
| **6. Native wrappers & radio mesh (Tier 2)** | Capacitor Android/iOS + Tauri desktop; BLE / Wi-Fi Aware mesh; CallKit/Telecom ringing; background location | Field test with 100+ devices |
| Later | Federation (MIMI), LoRa hardware bridge | — |

## 2.1 Phase 1 checklist (2026-10-29)

Worked in this order; tick items as their PRs merge.

**Done:** sign-up (phone at first, usernames and invites since ADR-0021), device keys and key directory; server delivery
(durable queue, ack/redelivery, one commit per epoch); 1:1 chats and groups
up to 50 (create, add people); offline outbox; encrypted local storage
surviving reloads; three-engine browser CI against a real server.

1. [x] Group re-sync on reconnect: a client that lost the server's answer to
   its commit asks the server whether it was accepted (docs/03 §5.3 gap).
2. [x] Group roles (owner/admin/member, FR-MSG-4); remove people, leave,
   rename.
3. [x] Web Push notifications without content (FR-NOT-1/2).
4. [x] Send authorisation: devices may only send to members of
   conversations they share; basic anti-spam.
5. [x] Server rate limits per device on lookup, claim and send; SMS-pumping
   protection beyond per-number limits (FR-SAF-2, NFR-LEG-5).
6. [x] Continuous deployment to the dev k3s cluster: build images, run
   `scripts/k3s-dev-deploy.sh` for real. Done as a pull-based timer on the
   host (ADR-0018); the owner installs it once (deploy/k3s/README.md).
7. [x] Measure delivery p95 < 1 s: load test plus basic server metrics
   (doc 12: p95 16 ms at 800 deliveries/s; Prometheus metrics on :9090).
8. [x] Device linking by QR (FR-ID-3/4): self-sync of sent messages, list
   and remove devices (ADR-0019).
9. [x] Safety numbers / QR verification and key-change warnings (FR-ID-5/6,
   ADR-0020).
10. [x] Block and report (FR-ID-8); message requests (FR-SAF-3, should).
    Reports carry only messages the reporter includes; franking (FR-SAF-1) later.
11. [x] Delete account and all server data (FR-ID-9).
12. [x] Delivered/read receipts (FR-MSG-5).
13. [x] PWA polish: install prompt, persistent-storage request and warning,
    update banner (FR-PLAT-2/3).
14. [x] Key-package replenishment driven by a server-reported count.
15. [x] Retry and clear feedback for messages the server rejects.
16. [x] ~~Real SMS provider~~ replaced by usernames and invite-only sign-up
    (ADR-0021); no SMS anywhere.

**Exit:** internal dogfood on the dev cluster; delivery p95 < 1 s.

**Can slip to later phases (should-haves):** typing indicators, reply/quote,
reactions, edit and delete-for-everyone, disappearing messages, mentions and
mute, local search, IP-hiding relay option.

## 2.2 Phase 2 checklist (2026-10-29)

Media, location and backup; exit: feature-complete beta. Worked in this
order; tick items as their PRs merge.

1. [x] Members keep every member's devices in each group: add contacts' new
   devices, remove deleted ones (prerequisite for restore; ADR-0022).
2. [x] Encrypted backup with a recovery key, and restore onto a new device
   (FR-MSG-13, ADR-0010, ADR-0022).
3. [x] Blob storage for encrypted attachments: upload and download, 100 MB
   limit, 30-day expiry (FR-MED-2/3, S3-compatible; MinIO on k3s).
4. [x] Images and files: encrypted on the device, EXIF stripped,
   thumbnails sent encrypted (FR-MED-1/2/4/8, ADR-0024).
5. [x] Voice notes and audio/video clips (FR-MED-1, ADR-0024).
6. [x] Resumable transfers and an auto-download policy (FR-MED-5/6, should;
   ADR-0025).
7. [x] Share location once, with self-hosted map tiles (FR-LOC-1/4/5,
   ADR-0008, ADR-0026).
8. [x] Live location for 15 min / 1 h / 8 h while the app is open, with a
   persistent indicator (FR-LOC-2/3/6, ADR-0027).
9. [x] Move backups into blob storage (they started in PostgreSQL; ADR-0022
   addendum).

**Exit:** feature-complete beta.

**UI polish backlog** (noted 2026-10-30 from screenshots; owner: "leave the
polish for later"):
- Size and Save text on our own attachments is hard to read on the blue
  bubble.
- An opened full-size photo looks faded (disabled-button styling).
- On phones, six settings sections sit above the conversation list; move
  settings to their own screen.
- The phone conversation header wraps ("Add people").
- General visual pass: avatars, hierarchy, spacing.

**Phase 0 spikes still open** (block later phases, not Phase 1): (b)
SQLite3MultipleCiphers on OPFS (deferred; IndexedDB snapshots suffice for
now); (c) phone-hotspot QR WebRTC test (needs two physical phones); (d)
SFrame 3-party call through LiveKit; (a) record benchmark timings in
Firefox and WebKit.

## 3. Top risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Web code delivery: a compromised server ships malicious JS to a target | High | Doc 04 §9: reproducible builds, transparency log, service-worker update gate, native wrappers for high-risk users |
| Browser storage eviction loses keys/history | High | Persistent storage request, install prompt, linked devices, encrypted backup |
| Hotspot/LAN quirks break QR-paired WebRTC (client isolation, mDNS) | High | Phase 0 spike (c); fallback: the hotspot host relays for others |
| No background execution on web (missed calls, live location pauses) | Medium | Honest UX; native wrappers in phase 6 |
| Stranger spam/abuse offline (no verified identity) | Medium | Doc 07 §8 |
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

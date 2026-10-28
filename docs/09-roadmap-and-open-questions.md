# 09 — Roadmap & Open Questions

**Status:** Draft

## 1. Phased roadmap (indicative)

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| **0. Discovery & spikes** | Accept ADRs 0001–0005; spikes: (a) OpenMLS on iOS+Android via Rust core, (b) BLE iOS↔Android text exchange incl. background, (c) SFrame through chosen SFU | Spikes demoed; risks re-assessed |
| **1. MVP messaging** | Accounts, device keys, 1:1 + group text (MLS), push, encrypted local storage | Internal dogfood; delivery p95 < 1 s |
| **2. Media & location** | Encrypted attachments, voice notes, one-shot + live location | Feature-complete beta |
| **3. Calling** | 1:1 calls, then group calls via SFU with SFrame | Call success ≥ 99% |
| **4. Offline mode** | BLE text with contacts, then mesh relay, then Wi-Fi media | Field test (100+ devices) |
| **5. Hardening & launch** | Multi-device, key transparency, external audit, bug bounty | Audit findings closed |
| Later | Desktop, web, backups, federation, LoRa hardware | — |

Offline spike is in Phase 0 deliberately: it is the requirement most likely
to force architectural changes (protocol choice, platform choice).

## 2. Top risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| iOS background BLE limits make offline mode unreliable | High | Early spike; set honest UX expectations (foreground mode) |
| MLS ordering vs. offline mode | High | "Freeze membership offline" (doc 07 §4) |
| Group call E2EE complexity | Medium | Use SFU with proven SFrame support |
| Building our own crypto integration incorrectly | High | Audited libraries only; external audit; fuzzing |
| Abuse/spam with no content visibility | Medium | Franking, rate limits, message requests |
| App store policy (background location/BLE/VoIP push) | Medium | Early policy review |

## 3. Open questions for stakeholders

1. **Platforms**: iOS + Android first? Is desktop or web needed at launch?
2. **Identity**: phone number, username, email, or anonymous IDs? (Phone
   numbers ease discovery but are a privacy/metadata cost.)
3. **Scale**: expected users at launch and in 2 years? Max group size (1,000
   assumed)? Max group call size (32 video assumed)?
4. **Open source**: will client and/or server code be published?
5. **Hosting / jurisdiction**: where will servers run? Any data-residency
   needs?
6. **Business model**: free / paid / enterprise? Affects backups, storage
   retention, federation.
7. **Backups**: are encrypted cloud backups required, or is device-to-device
   transfer enough?
8. **Offline scope**: contacts only, or also discovering/messaging strangers
   nearby (e.g., disaster broadcast)? Must offline mode work in the
   background on iOS?
9. **Federation / self-hosting**: should organisations be able to run their
   own server?
10. **Team**: existing language/platform skills (Rust? Swift/Kotlin?
    Flutter? Go/Elixir?) — strongly influences ADR-0003/0005.
11. **Compliance**: any regulated customers (health, government) or target
    regions with E2EE restrictions?
12. **Retention defaults**: 30-day server queue / blob retention acceptable?

## 4. Assumptions register

All `[ASSUMPTION]` tags across docs 01–08, collected:

| Doc | Assumption |
|-----|------------|
| 01 | iOS + Android first; desktop/web later |
| 02 | Phone number optional; username supported |
| 02 | Max group 1,000; group video 32 / audio 100 |
| 02 | Offline queue + blob retention 30 days |
| 02 | Attachment limit 100 MB |
| 02 | 100k MAU initial capacity |
| 02 | Mesh idle battery < 3%/h |
| 02 | Client open source |
| 04 | No client-side content scanning |
| 06 | Live location relayed ≤ 2 hops offline |
| 07 | Mesh hop limit 7, TTL 24 h; no backfill of offline history |

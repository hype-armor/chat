# 01 — Vision & Scope

**Status:** Draft

## Vision

A private messenger where the service operator *cannot* read users'
messages, media, calls, or locations — and which keeps working when there is
no internet, by falling back to direct Bluetooth / Wi-Fi links between nearby
devices.

## Goals

1. **Privacy by construction.** End-to-end encryption (E2EE) is always on, for
   every content type, in every conversation type. There is no "unencrypted
   mode".
2. **Feature parity with mainstream messengers** for the core set: 1:1 and
   group text, rich media, voice/video calls (1:1 and group), location sharing.
3. **Resilience.** Optional serverless operation for nearby users (protests,
   disasters, festivals, flights, rural areas).
4. **Minimal server knowledge.** The server stores as little metadata as
   practical and only for as long as needed for delivery.

## Non-goals (v1)

- Public channels / broadcast to unbounded audiences.
- Federation with other messaging networks (revisit later — see ADR-0009).
- Bots / third-party integrations.
- Payments.
- Server-side search, backups, or AI features that require plaintext.
- Anonymity against a global network adversary (we minimise metadata but are
  not Tor).

## Target users & personas

| Persona | Needs |
|---------|-------|
| Everyday user | Familiar UX, reliable delivery, media, calls with family/friends |
| Privacy-conscious user | Verifiable encryption, minimal metadata, disappearing messages |
| Off-grid / crisis user | Messaging without infrastructure, low battery use, store-and-forward |
| Group organiser | Groups of tens to hundreds, admin controls, group calls |

## Platforms **[ASSUMPTION]**

iOS and Android first. Desktop (macOS/Windows/Linux) and Web are later
phases. Web is a poor fit for E2EE key storage and for Bluetooth, so it is the
lowest priority. Needs confirmation — see doc 09.

## Success metrics (initial)

- Message delivery p95 < 1 s when both parties online.
- Call setup p95 < 3 s; ≥ 99% of calls connect (including via TURN).
- Zero plaintext user content observable server-side (verified by audit).
- Offline mode: two phones in BLE range exchange a text in < 5 s.

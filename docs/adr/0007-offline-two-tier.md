# ADR-0007: Offline mode: WebRTC local mode (web) + radio mesh (native)

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** FR-OFF-*

## Context
Browsers can't advertise over Bluetooth, use Wi-Fi Direct/Aware, or discover peers on a LAN. Yet the product is web-first and offline mode must include strangers.

## Options considered
1. **Tier 1 WebRTC over local network with QR signalling** (pure web) + **Tier 2 native radio mesh**.
2. **Web Bluetooth only**: central role only, Chromium only, no iOS — can't form a mesh.
3. **Defer offline entirely until native**: drops a core requirement from the web product.

## Decision
Two tiers sharing envelopes and mesh routing (doc 07). Freeze MLS membership offline. Strangers use ephemeral room identities; room chat is treated as public.

## Consequences
Tier 1 needs a shared network (a hotspot is fine) and a QR scan. Automatic Bluetooth discovery waits for native wrappers.

## Validation
Spike: two phones (iOS Safari PWA + Android Chrome) on a hotspot with no internet exchange messages after QR pairing; a third joins through the mesh.

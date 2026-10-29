# ADR-0006: Calls: LiveKit SFU + coturn, SFrame keyed from MLS

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** FR-CALL-*

## Context
1:1 and group (≤ 50) calls in browsers must stay end-to-end encrypted through media servers.

## Options considered
1. **LiveKit**: Apache-2.0, self-hostable, browser SDK, simulcast, custom E2EE key provider.
2. **mediasoup**: very efficient but low-level; we'd build the room logic ourselves.
3. **Jitsi**: mature, but heavier to self-host and Java-based.
4. **Full mesh**: upload bandwidth explodes beyond about 4 people.

## Decision
1:1 calls peer-to-peer with coturn fallback; group calls via LiveKit. SFrame keys derived per sender from the MLS exporter. Refuse to join group calls on browsers without encoded transforms.

## Consequences
We implement a LiveKit key provider fed by our core. Active-speaker audio levels remain visible to the SFU (documented leak).

## Validation
Spike: an SFrame-encrypted 3-party call across Chrome, Firefox and Safari through LiveKit.

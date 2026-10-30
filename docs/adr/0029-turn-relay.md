# ADR-0029: coturn as the one TURN relay; "always relay calls"

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** project owner, Claude
- **Related requirements:** FR-CALL-1, FR-CALL-9, NFR-OPS-1
- **Builds on:** ADR-0006, ADR-0028

## Context
Peer-to-peer calls fail between some networks (symmetric NATs, strict
firewalls) unless media can go through a TURN relay. FR-CALL-9 also asks
for an option to always relay, so the person called never learns the
caller's IP address. The k3s plan gave UDP 3478 and TCP 5349 to LiveKit's
built-in TURN, but that TURN only accepts LiveKit sessions, and two TURN
servers can't share those ports on one node.

## Decision
1. **coturn is the single TURN server.** It ships in our Helm chart
   (`turn.enabled`), with host networking, UDP/TCP 3478, TURN over TLS on
   TCP 5349 (cert-manager certificate) and relay ports UDP 49152-49999,
   below LiveKit's 50000-60000 media range. LiveKit's own TURN is turned
   off; group calls will be given coturn credentials when they arrive
   (Phase 3 item 5).
2. **Shared-secret credentials** (coturn `use-auth-secret`), as in
   ADR-0028: the server signs 12-hour credentials, coturn verifies them
   with no database and no per-user state.
3. **The relay can't be aimed inward.** coturn refuses peers in private,
   loopback, link-local, carrier-grade NAT and other special ranges
   (`turn.deniedPeerIps`), so a client can't use it to reach the cluster
   or the node's networks. Per-credential and total allocation quotas cap
   abuse.
4. **No relay logs by default.** coturn's session logs name both sides'
   IP addresses; they stay off unless an operator turns them on to debug.
5. **"Always relay calls"**, a per-device privacy setting (off by
   default): the page creates its `RTCPeerConnection` with
   `iceTransportPolicy: 'relay'`, so only relayed candidates leave the
   device and the other side sees only the relay's address. The call
   doesn't start if the server offers no TURN server, rather than quietly
   falling back to a direct connection.

## Consequences
- Direct connections stay the default: lower latency and no relay
  bandwidth, at the cost of each side seeing the other's address.
- Relayed calls cost the operator bandwidth (both directions of a call go
  through the node); the quotas bound it.
- The setting is per device and is not synced to linked devices or kept
  in backups.
- Docker compose runs coturn for development without the private-range
  block, so calls can be relayed on a home network.
- Host networking bypasses NetworkPolicy for the coturn pod; it listens
  only on the TURN ports.

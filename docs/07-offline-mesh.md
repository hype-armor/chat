# 07 — Offline / Serverless Mode

**Status:** Draft — highest technical risk area; needs a prototype spike
before committing (see doc 09).

## 1. What "serverless" means here

Devices exchange the **same E2EE envelopes** used online, but over local
radio links, optionally relayed by other app users (store-and-forward mesh).
There is no server for ordering, key directory, or storage.

Opt-in only (FR-OFF-1): it costs battery and broadcasts a (rotating)
presence beacon.

## 2. Transport options

| Transport | Range | Throughput | iOS | Android | iOS↔Android | Use |
|-----------|-------|-----------|-----|---------|-------------|-----|
| Bluetooth LE (GATT / L2CAP CoC) | ~10–100 m | ~10s–100s kbps practical | ✅ (CoreBluetooth; background limits) | ✅ | ✅ **only common denominator historically** | Discovery, text, control |
| Apple Multipeer Connectivity | ~Wi-Fi | High | ✅ | ❌ | ❌ | iOS↔iOS media |
| Wi-Fi Direct | ~50–100 m | High (Mbps) | ❌ | ✅ | ❌ | Android↔Android media |
| Wi-Fi Aware (NAN) | ~50 m | High | iOS 26+ framework (verify interop) | ✅ Android 8+ (device-dependent) | Possibly — **spike required** | Media, calls |
| Same LAN (mDNS + TCP/QUIC) | Network | High | ✅ | ✅ | ✅ | Hotspot / local router without internet |
| Google Nearby Connections | — | — | Limited | ✅ | Partial | Rejected: proprietary, Play Services dependency |

**Plan:** BLE for discovery and text everywhere; upgrade to the best
available high-bandwidth link (Wi-Fi Aware → Wi-Fi Direct / Multipeer →
LAN) for media when both peers support it.

## 3. Protocol layers

```
┌───────────────────────────────────────────────┐
│ E2EE envelope (same as online)                │
├───────────────────────────────────────────────┤
│ Mesh routing: msg_id, dest tag, TTL, hops,    │
│ dedup bloom filter, spray-and-wait            │
├───────────────────────────────────────────────┤
│ Link security: Noise (XX/IK) session between  │
│ neighbours — authenticates & hides headers    │
├───────────────────────────────────────────────┤
│ Fragmentation / reassembly / flow control     │
├───────────────────────────────────────────────┤
│ BLE │ Wi-Fi Aware │ Wi-Fi Direct │ MPC │ LAN  │
└───────────────────────────────────────────────┘
```

### Discovery & privacy
- Beacons carry a **rotating pseudonymous token** (e.g., HMAC of a time
  window with a key shared among contacts), so contacts recognise each
  other but strangers can't track a device over time.
- Relaying for strangers uses an anonymous token only.

### Routing
- **Epidemic / spray-and-wait** store-and-forward with: hop limit
  (**[ASSUMPTION]** 7), TTL (24 h), per-peer rate limits, and per-device
  relay storage quota (e.g., 50 MB, LRU).
- **Destination tags** are blinded (recipient can recognise messages for
  them; relays can't link tag → identity).
- Deduplicate by message ID; sync via "I have / I want" summaries when two
  peers meet.

## 4. Cryptography offline — the MLS ordering problem

MLS (doc 04) requires a single agreed order of **commits** per group.
Offline, two partitions could each commit, forking the group.

| Approach | Description | Verdict |
|----------|-------------|---------|
| **A. Freeze membership offline** | Offline nodes may send *application messages* in the current epoch, but may not commit (no add/remove/key-update). Commits wait until online. | **Proposed for v1** — simple, safe |
| B. Designated committer | Only the group owner/admin device may commit offline | Fragile if that device is absent |
| C. Decentralised MLS (DMLS / fork-resolution research) | Allow forks and merge | Research-grade; revisit later |
| D. Pairwise Double Ratchet for offline | Use per-pair ratchets, fan out per member | Works without ordering; O(n) cost; a second protocol to audit |

Consequences of A:
- Offline sessions have FS within an epoch (per-message ratchets) but
  weaker PCS until the next online commit.
- New contacts met offline (FR-OFF-7) need a 1:1 group created offline: a
  2-member group's initial welcome is fine without a server because nobody
  else can commit; QR exchange carries a key package.
- Key packages: devices pre-cache contacts' key packages while online;
  offline QR exchange covers strangers.

## 5. Reconciliation when back online (FR-OFF-8)

- Messages carry `{sender_device, epoch, generation, lamport clock,
  wall-clock}`; clients merge offline history into conversation timelines
  ordered by `(epoch, lamport, sender)` and display with original
  timestamps.
- Clients upload nothing extra to the server; peers who weren't present
  offline simply never see offline-only messages unless a client
  re-shares them (**[ASSUMPTION]** we don't backfill; open question).

## 6. Threats specific to offline mode

| Threat | Mitigation |
|--------|-----------|
| Tracking via BLE beacons | Rotating tokens, MAC randomisation |
| Flooding / storage DoS | Hop/TTL limits, rate limits, quotas, optional proof-of-work on relayed messages |
| Sybil relays dropping messages | Multi-path spray, delivery receipts |
| Malicious packet parsing | Fuzzed parsers in memory-safe language |
| Impersonation | All content authenticated by E2EE; link layer by Noise |

*Lesson from prior art:* Bridgefy's early mesh protocol was publicly
broken (2020); Briar and Berty are better references. Our mesh design must be
reviewed by the same auditors as the main protocol.

## 7. Platform constraints (major risk)

- **iOS background BLE** is heavily restricted: advertising in background
  moves data to an overflow area only discoverable by iOS devices actively
  scanning for that service UUID; scanning is throttled. Reliable offline
  mode on iOS likely requires the app in foreground or a recent foreground
  session.
- **Android** requires a foreground service with a persistent notification
  for continuous scanning; OEM battery killers vary.
- Battery budget: NFR-RES-2.

## 8. Prior art to study
Briar (Tor + BT + Wi-Fi, Bramble protocols), Berty (Wesh protocol, IPFS-based),
Bridgefy, Meshtastic (LoRa — possible future hardware add-on), FireChat,
Apple's Find My offline-finding crypto design.

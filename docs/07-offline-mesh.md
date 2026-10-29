# 07 — Offline / Serverless Mode

**Status:** Draft — highest technical risk; prototype spikes are scheduled
in Phase 0 (doc 09).

## 1. What "serverless" means here

Devices exchange the **same E2EE envelopes** used online, over local links
and relayed by other app users, with no server for ordering, key directory,
or storage. Opt-in only (FR-OFF-1).

Because the product is **web/PWA first**, offline mode comes in two tiers:

| Tier | Runs in | Link | Discovery | Ships |
|------|---------|------|-----------|-------|
| **1. Local mode** | Any modern browser / installed PWA | WebRTC data channels over a shared local network (router with no uplink, or one phone's hotspot) | Scan a QR code once; after that, peers introduce each other | Phase 4 |
| **2. Radio mesh** | Native wrappers (Android, iOS, desktop) | Bluetooth LE + Wi-Fi Aware / Wi-Fi Direct / Multipeer | Automatic, in the background | Phase 6 |

Both tiers carry the same envelopes and mesh routing, so a native device on
the same network bridges Tier 1 rooms to the Tier 2 radio mesh.

## 2. Why the browser can't do Bluetooth/Wi-Fi mesh

| Capability needed | Browser support |
|-------------------|-----------------|
| BLE advertising / peripheral role (be discoverable) | **None** in any browser |
| BLE central role (connect to a device) | Web Bluetooth: Chromium only, not Safari/iOS, needs a user-picked device each time, no background — can't build a mesh |
| Wi-Fi Direct / Aware / Multipeer | **None** |
| LAN discovery (mDNS, UDP broadcast, raw sockets) | **None** |
| WebRTC peer-to-peer over the local network | **Yes**, everywhere, but needs the offer/answer exchanged somehow |
| Running in the background | Very limited (service worker only, short-lived) |

So Tier 1 uses WebRTC and solves signalling with QR codes; automatic
discovery needs native code.

## 3. Tier 1 — Local mode (browser)

### 3.1 Prerequisites
- Each user loaded the PWA while online (it is cached by the service worker
  and runs offline afterwards). A browser can't serve the app to a newcomer:
  web pages can't run an HTTP server, and service workers / camera /
  WebRTC need a secure (HTTPS) origin.
- Devices are on the same local network: one phone's hotspot is enough;
  no internet is needed.

### 3.2 Pairing and joining
1. Host taps **"Start local room"**. The core creates a room
   `{room_id, room_key, host ephemeral pubkey}` and a compact WebRTC offer
   (ICE ufrag/pwd, DTLS fingerprint, host candidates), all encoded in one
   QR code.
2. Joiner scans it. Their browser builds an answer and shows it as a QR code;
   the host scans it back. (Two scans for the very first link.)
3. Once one data channel is open, **the mesh does signalling**: further
   joiners scan *any* member's room QR, and the room exchanges WebRTC
   offers/answers over existing data channels, so each newcomer meets the
   rest of the room without more scanning.
4. Keep each device's direct connections bounded (e.g., ≤ 8) and relay the
   rest via mesh routing (§6) so phones don't hold 50 connections.

**ICE detail to verify in the spike:** browsers hide local IPs behind
mDNS `.local` names unless the page has camera/microphone permission.
We already need the camera to scan, so real host candidates should be
available; we still need to test hotspots on iOS and Android, where client
isolation or mDNS blocking might break this.

### 3.3 Who you can talk to
- **Contacts**: devices recognise each other by long-term identity keys,
  and existing 1:1 and group conversations continue (§5).
- **Strangers** (FR-OFF-10):
  - Every room member has a fresh **ephemeral room identity**: a new key
    pair, a display name, and an avatar. No phone number, no long-term
    key.
  - **Room chat**: messages encrypted with the room key from the QR code.
    This keeps out anyone who isn't in the room, but treat it as **public
    to everyone who has the QR**; the UI labels it that way.
  - **Direct messages to a stranger**: a 2-member MLS group between the two
    ephemeral identities. It is private, but whether the person is who they
    say they are is unverified.
  - **Promote to contact** (FR-OFF-11): both users consent; they swap
    long-term identity keys (and, optionally, usernames) inside the
    encrypted DM and compare a safety code.
- **Broadcasts** (FR-OFF-12): signed by the sender's room identity, relayed
  across the room/mesh, and marked "unverified" unless signed by a contact.

### 3.4 Calls in local mode
WebRTC media goes directly over the same local connections: 1:1 calls, or
a full mesh of up to ~4 people. SFrame is still applied (FR-CALL-10).

## 4. Tier 2 — Radio mesh (native wrappers)

| Transport | Range | Throughput | iOS | Android | Cross-OS | Use |
|-----------|-------|-----------|-----|---------|----------|-----|
| Bluetooth LE (GATT / L2CAP) | 10–100 m | 10s–100s kbps | ✅ (background limits) | ✅ | ✅ | Discovery, text, control |
| Wi-Fi Aware (NAN) | ~50 m | Mbps | iOS 26+ framework | ✅ (device-dependent) | Possibly — spike | Media, calls |
| Wi-Fi Direct | ~100 m | Mbps | ❌ | ✅ | ❌ | Android↔Android media |
| Multipeer Connectivity | Wi-Fi range | Mbps | ✅ | ❌ | ❌ | Apple↔Apple media |
| Local network (WebRTC) | network | Mbps | ✅ | ✅ | ✅ + browsers | Bridge to Tier 1 |

- Automatic discovery uses rotating pseudonymous BLE beacons: contacts
  recognise them through an HMAC keyed with a secret shared between
  contacts; strangers see only a random per-window token plus "open to
  strangers" if the user enabled it.
- Platform limits: on iOS, BLE advertising and scanning in the background
  are throttled (overflow area), so reliable discovery mostly needs the app
  in the foreground. On Android, continuous scanning needs a foreground
  service with a notification. Budget: NFR-RES-2.

## 5. Cryptography offline: the MLS ordering problem

MLS needs one agreed order of **commits** per group. Offline partitions
could each commit and split the group into incompatible versions.

**Decision (ADR-0007): freeze membership offline.**
- Offline devices may send *application messages* in the group's current
  epoch, but may not commit: no adding or removing members, no key updates.
  Commits wait until the device is back online.
- 2-member groups created offline (new contact, stranger DM) are safe:
  their welcome needs no server, and a later re-key goes through the server
  once online.
- Cost: forward secrecy holds within an epoch (per-message ratchet), but
  post-compromise healing waits until the next online commit. With groups
  capped at 50, re-keying on reconnect is cheap.
- Devices pre-cache contacts' key packages while online. QR exchanges carry
  key packages for strangers.

Considered and rejected for v1: a single designated device that may commit
offline (fails when that device is absent); decentralised MLS with fork
merging (still research); a second, pairwise-ratchet protocol for offline
use (another protocol to audit).

## 6. Mesh routing (both tiers)

```
┌───────────────────────────────────────────────┐
│ E2EE envelope (same as online)                │
├───────────────────────────────────────────────┤
│ Mesh: msg_id, blinded dest tag, TTL, hops,    │
│ have/want sync, spray-and-wait                │
├───────────────────────────────────────────────┤
│ Link auth: DTLS (WebRTC) or Noise XX (radio)  │
├───────────────────────────────────────────────┤
│ WebRTC data channel │ BLE │ Wi-Fi Aware │ ... │
└───────────────────────────────────────────────┘
```
- Store-and-forward with hop limit 7 and TTL 24 h; per-device relay quota
  (e.g., 50 MB, least-recently-used eviction).
- Blinded destination tags: recipients recognise their messages; relays
  can't tell who the recipient is.
- When two peers meet, they exchange "have"/"want" summaries.
- Location updates: no more than 2 hops.

## 7. Reconciliation when back online (FR-OFF-8)

- Envelopes carry `{sender_device, epoch, generation, lamport clock,
  wall clock}`. Clients merge offline history into timelines ordered by
  `(epoch, lamport, sender)` and show the original timestamps.
- Offline messages reach group members who were not present only if a
  member's device re-sends them through the server after reconnecting.
  **Decision: yes, for contact groups**: a sender's device re-sends its own
  offline-sent messages once online, and receivers drop duplicates by
  msg_id. Room and stranger traffic is never uploaded.

## 8. Threats specific to offline mode & strangers

| Threat | Mitigation |
|--------|-----------|
| Tracking via beacons / ephemeral IDs | Rotating tokens, a fresh room identity per room, MAC randomisation |
| Spam/flooding by strangers (no verified identity offline) | Per-identity rate limits, small proof-of-work on broadcasts, hop/TTL limits, local block/mute, stranger media blurred and not auto-downloaded |
| Impersonation of a contact | Contacts verified by long-term keys; strangers clearly labelled; promoting needs a safety-code comparison |
| Fake "official" emergency broadcasts | Always marked unverified unless signed by a contact |
| Sybil relays dropping messages | Multi-path spray, delivery receipts |
| Malicious packets | Parsers written in Rust and fuzzed |
| Room QR leaked/photographed | Room chat treated as public; DMs use separate keys |

*Prior art:* Bridgefy's early mesh protocol was publicly broken (2020).
Briar (Bramble), Berty (Wesh), and Meshtastic are better references. The
mesh design goes to the same auditors as the main protocol.

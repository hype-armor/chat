# 04 — Security & Cryptography

**Status:** Draft

## 1. Threat model

### Assets
Message content, media, call audio/video, locations, identity keys, contact
graph (who talks to whom), group membership, timing/presence metadata.

### Adversaries

| Adversary | Capability | Must we defend? |
|-----------|-----------|-----------------|
| Network attacker | Observe/modify traffic | **Yes** — TLS + E2EE |
| Malicious or compromised server operator | Read/modify everything server-side, inject keys | **Yes** for content; **partially** for metadata |
| Other users / ex-group members | Hold old keys | **Yes** — removal rotates keys (PCS) |
| Nearby attacker in offline mode | Sniff BLE/Wi-Fi, impersonate peers, flood mesh | **Yes** |
| Device thief (locked device) | Physical access | **Yes** — at-rest encryption + keystore |
| Device thief (unlocked) / malware on device | Full access | **No** (out of scope; mitigate with app lock, disappearing messages) |
| Global passive network adversary | Correlate all traffic | **No** (out of scope) |

### Security goals
- **Confidentiality & integrity** of all content end-to-end.
- **Authentication:** recipients know which *device* sent a message.
- **Forward secrecy (FS):** compromise today doesn't expose past messages.
- **Post-compromise security (PCS):** the session heals after a compromise.
- **Key-substitution resistance:** server can't silently swap keys
  (safety numbers + key transparency).
- **Deniability:** *nice to have*, not required.

## 2. Protocol options

| | **MLS (RFC 9420)** | **Signal Protocol** (PQXDH + Double Ratchet + Sender Keys) | **Olm/Megolm (Matrix)** |
|---|---|---|---|
| Group scaling | O(log n) membership changes — designed for large groups | Sender Keys: O(n) on membership change | O(n), weaker PCS for groups |
| FS / PCS in groups | Strong, built in | Good 1:1; group PCS weaker | Weaker |
| Standardisation | IETF standard | De-facto standard, well studied | Matrix spec; moving to MLS |
| Post-quantum | PQ/hybrid ciphersuites being standardised | PQXDH + SPQR (shipped by Signal) | Not yet |
| Mature libraries | OpenMLS (Rust, MIT), MLS++ (C++, BSD) | libsignal (Rust, **AGPL-3.0**) | vodozemac (Rust, Apache-2.0) |
| Ordering requirement | Needs a Delivery Service to **order commits** — tension with offline mode | No global ordering needed — great for offline | No global ordering |
| Real-world | Webex, RCS (GSMA Universal Profile 3.0), Wire, Discord DAVE | Signal, WhatsApp | Element/Matrix |

### Recommendation (pending ADR-0002)

**MLS for all conversations (1:1 treated as a 2-member group)**, using
OpenMLS, with a hybrid post-quantum ciphersuite once available in the
library. Rationale: one code path for 1:1 and groups, best group
scalability, IETF standard, permissive licence, and native exporter secrets
to key group calls (doc 05).

Main risk: MLS needs commits to be totally ordered per group, which is easy
with a server and hard in a mesh. Doc 07 describes how offline mode handles
this (offline = application messages only within an existing epoch;
membership changes deferred until online).

## 3. Key management

| Key | Where generated | Storage | Lifetime |
|-----|----------------|---------|----------|
| Device identity (signature) key | Device | Platform keystore (non-exportable where possible) | Life of device |
| MLS key packages (init keys) | Device | Public part uploaded to Key Directory; private in encrypted DB | Single-use, expire ~30 days |
| Group epoch secrets | Derived per epoch | Encrypted local DB | Deleted after epoch advance + grace window |
| Attachment keys | Per file, random | Inside encrypted message | Life of message |
| Call media keys | Exported from MLS epoch | Memory only | Life of call / epoch |
| Local DB key | Device | Wrapped by keystore | Life of install |

### Identity verification
- **Safety numbers / QR codes** per contact (out-of-band comparison).
- **Key transparency** (S): a verifiable append-only log of
  account→device-key bindings, so clients can audit that the server isn't
  equivocating (cf. WhatsApp/Apple key transparency, IETF KEYTRANS WG).

## 4. Metadata protection

| Technique | Protects | Priority |
|-----------|---------|---------|
| Sealed-sender style anonymous delivery tokens | Sender identity from server | S |
| Encrypted group state (membership, name, avatar inside MLS) | Group membership from server | S |
| Content-free push notifications | Content from Apple/Google | M |
| Padding message sizes to buckets | Message length leakage | S |
| Private contact discovery (hashed + rate-limited, or PSI/enclave) | Address book | S |
| Delete delivery records on ack | Historical metadata | M |
| Optional IP-hiding relay for calls | User IP from call peer | S |

## 5. At-rest security
- Local database encrypted (e.g., SQLCipher-class) with key in
  Secure Enclave/StrongBox-backed keystore.
- Optional app lock (biometric/PIN).
- Disappearing messages delete from local DB and secure-delete attachments.

## 6. Abuse handling under E2EE
- **Message franking**: reporters can prove to the server that a reported
  message was really sent by the accused, without the server reading
  unreported messages.
- Rate limiting, registration friction, and user-side blocking.
- No client-side scanning of content. **[ASSUMPTION — policy decision]**

## 7. Backup **(open — ADR-0010)**
Options: no backups (device transfer only); encrypted backups with a
user-held recovery key; PIN-derived keys protected by a server-side
hardware enclave with guess limits. Every option is a trade-off between
recoverability and attack surface.

## 8. Assurance
- Use only audited libraries; no hand-rolled crypto.
- Formal protocol review + third-party penetration test before launch.
- Fuzzing of envelope parsers and mesh packet parsers.
- Bug bounty after launch.

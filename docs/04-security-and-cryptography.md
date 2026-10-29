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
| Malicious web-app delivery (our server or CDN serves modified JS/WASM) | Steal keys/plaintext from browser clients | **Yes** — see §9; the hardest problem of web-first E2EE |
| Malicious browser extension | Read page/DOM | **No** (warn users; core in worker limits exposure) |
| Strangers in offline open rooms | Spam, impersonation, social engineering | **Yes** — see doc 07 §5 |
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
| Mature libraries | OpenMLS (Rust, MIT; compiles to WASM), MLS++ (C++, BSD) | libsignal (Rust, AGPL-3.0 — fine now we're fully open — but no supported browser/WASM build) | vodozemac (Rust, Apache-2.0; WASM) |
| Ordering requirement | Needs a Delivery Service to **order commits** — tension with offline mode | No global ordering needed — great for offline | No global ordering |
| Real-world | Webex, RCS (GSMA Universal Profile 3.0), Wire, Discord DAVE | Signal, WhatsApp | Element/Matrix |

### Decision (ADR-0002)

**MLS for all conversations (1:1 treated as a 2-member group)**, using
OpenMLS compiled to WASM, with a hybrid post-quantum ciphersuite once
available in the library. With groups capped at 50, MLS's O(log n) scaling
matters less than it would at 1,000 — the deciding reasons are: one code
path for 1:1 and groups, IETF standard, strong group PCS, a library that
runs in the browser, and exporter secrets to key group calls (doc 05).

Main risk: MLS needs commits to be totally ordered per group, which is easy
with a server and hard in a mesh. Doc 07 describes how offline mode handles
this (offline = application messages only within an existing epoch;
membership changes deferred until online).

## 3. Key management

| Key | Where generated | Storage | Lifetime |
|-----|----------------|---------|----------|
| Device identity (signature) key | Device | Encrypted local DB (key wrapped by non-extractable WebCrypto key; platform keystore in native wrappers) | Life of device |
| MLS key packages (init keys) | Device | Public part uploaded to Key Directory; private in encrypted DB | Single-use, expire ~30 days |
| Group epoch secrets | Derived per epoch | Encrypted local DB | Deleted after epoch advance + grace window |
| Attachment keys | Per file, random | Inside encrypted message | Life of message |
| Call media keys | Exported from MLS epoch | Memory only | Life of call / epoch |
| Local DB key | Device | Wrapped by non-extractable WebCrypto key (+ optional passphrase) | Life of install |

### Identity verification
- **Safety numbers / QR codes** per contact (out-of-band comparison),
  covering all of a contact's devices; new device keys trigger warnings
  (ADR-0020).
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
| Contact lookup by exact username only, strictly rate-limited; no search, directory or address-book upload (ADR-0021). The server holds no phone numbers or emails. | Social graph | M |
| Username never transmitted in offline mode or shown to strangers | Identity of offline users | M |
| Delete delivery records on ack | Historical metadata | M |
| Optional IP-hiding relay for calls | User IP from call peer | S |

## 5. At-rest security
- Local database (SQLite-WASM on OPFS) encrypted at page level, with the
  key wrapped by a non-extractable WebCrypto key; Secure Enclave /
  StrongBox in native wrappers.
- Optional app lock (biometric/PIN).
- Disappearing messages delete from local DB and secure-delete attachments.

## 6. Abuse handling under E2EE
- **Message franking**: reporters can prove to the server that a reported
  message was really sent by the accused, without the server reading
  unreported messages.
- Rate limiting, registration friction, and user-side blocking.
- No client-side scanning of content.

## 7. Backup (ADR-0010)
Browsers can evict storage, so "device transfer only" is not enough for a
web-first product. Decision: **encrypted backup with a user-held 128-bit
recovery key** (shown once, like a BIP-39 phrase) stored as an opaque blob
on the server. No PIN-plus-enclave scheme: it needs trusted hardware that
self-hosters can't be assumed to have.

## 8. Assurance
- Use only audited libraries; no hand-rolled crypto.
- Formal protocol review + third-party penetration test before launch.
- Fuzzing of envelope parsers and mesh packet parsers.
- Bug bounty after launch.

## 9. Web code-delivery integrity

On the web, the server delivers the client code on every load. A compromised
or coerced server could ship a key-stealing bundle to one targeted user.
This is the main weakness of browser E2EE and we must be honest about it.

Layered mitigations:

1. **Open source + reproducible builds** (NFR-SEC-9): anyone can rebuild the
   bundle and compare hashes.
2. **Immutable, versioned bundles**: every release is content-addressed
   (`/v/<hash>/...`) with Subresource Integrity on every script and WASM
   file; releases and their hashes are published in a public, append-only
   transparency log (e.g., signed git tags + Sigstore/Rekor entry).
3. **Service-worker update gate**: the installed service worker serves the
   pinned version and only switches to a new release after verifying its
   release signature and transparency-log inclusion; the UI shows the
   version hash. Limitation: browsers re-check the service worker script
   itself periodically, so this raises the bar rather than eliminating the
   risk. *Status (Phase 1):* a new version waits until the user taps
   "Update now"; signature and log verification before that come in
   Phase 5.
4. **Independent verifier extension** (C): a browser extension that checks
   loaded assets against the published log (cf. Meta's Code Verify).
5. **Native wrappers / signed web bundles** for high-risk users: code
   changes only on signed app updates. Chrome Isolated Web Apps are a
   possible future option.
6. **Self-hosting**: users who don't trust our server can run their own and
   serve the bundle themselves.

Also: strict Content Security Policy (no inline script, no `eval`, WASM
allowed via `wasm-unsafe-eval` only), Trusted Types, no third-party scripts
or analytics, COOP/COEP isolation.

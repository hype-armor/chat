# 05 — Media & Calling

**Status:** Draft

## 1. Attachments

### Pipeline (sender)
Details and rationale in ADR-0024.

1. Pre-process on device: photos are re-drawn on a canvas, which drops
   EXIF/GPS and all other metadata (FR-MED-8) and scales them to fit
   2560 px. A JPEG thumbnail of at most 48 KB is made. MP4/QuickTime clips
   have their recorded location blanked; videos get a poster frame as the
   thumbnail; voice notes are recorded in the app (Opus or AAC).
2. Generate a random 256-bit key and seal the file with the **STREAM**
   construction over AES-256-GCM (RustCrypto `aead`, 64 KiB chunks) in the
   core worker, so large files are processed piece by piece.
3. Pad the plaintext to a Padmé size (≤ 12% larger) to hide the exact length.
4. Upload the ciphertext to the server, which streams it into object
   storage (ADR-0023; not pre-signed URLs).
5. Send a regular E2EE message carrying `{blob_id, key, ciphertext SHA-256,
   mime, name, size, dimensions, thumbnail, caption}`.

### Receiver
Download (through the server, ADR-0023), verify the SHA-256 and every chunk,
decrypt chunk-wise. The sealed blob is kept on the device, so opening it
again needs no download. Only raster photos are shown inline; other types
are offered as downloads.

### Group fan-out
Upload **once**; the key goes into one group message. No per-recipient
re-upload.

### Retention
Blobs expire after 30 days, whether or not they were fetched. (Deleting
once every recipient has fetched would need the server to track fetches,
which leaks more metadata.)

## 2. Calling overview

All real-time media uses a WebRTC-class stack (ICE, DTLS-SRTP, Opus,
VP8/VP9/AV1/H.264) because it is the only mature, cross-platform option with
NAT traversal, echo cancellation, and bandwidth estimation built in.

| Call type | Topology | Server role |
|-----------|----------|-------------|
| 1:1 | Peer-to-peer; TURN relay fallback (or forced relay for IP privacy) | Signalling + TURN |
| Group (3–50) | **SFU** (LiveKit, ADR-0006) | Forwards encrypted frames; never decrypts |
| Offline, same local network | Direct WebRTC, host ICE candidates only; 1:1 or full mesh up to ~4 | None |

Mesh (everyone sends to everyone) is rejected for groups > 4: upload
bandwidth grows O(n).

## 3. Signalling

- Call offer/answer/ICE candidates are sent as **E2EE messages** over the
  normal messaging channel (so the server can't tamper with DTLS
  fingerprints).
- Server-side signalling only allocates SFU rooms/TURN credentials and
  notifies devices via Web Push. **Web limitation:** a closed PWA can only
  show a notification ("Incoming call — tap to answer"), not a ringing
  full-screen UI; native wrappers add CallKit / Android Telecom later.

## 4. End-to-end encryption of call media

DTLS-SRTP alone is hop-by-hop when an SFU is present (the SFU terminates
DTLS). So we add an **inner frame-level encryption layer**:

- **SFrame (RFC 9605)** applied to each encoded media frame before
  packetisation, using WebRTC Encoded Transform (`RTCRtpScriptTransform`
  in Safari/Firefox, encoded insertable streams in Chromium; feature-detect
  and refuse to join a group call unencrypted).
- **Keys**: derived from the conversation's MLS group via the MLS *exporter*
  (`MLS-Exporter("chat call sframe", call_id, 32)`); each sender gets its
  own key ID (RFC 9605 §5.2). When membership changes, the MLS epoch
  advances and call keys rotate. Frames are encrypted in the core worker,
  never on the page; details in ADR-0030.
- The SFU sees only RTP headers + minimal metadata needed for routing
  (and SFrame headers), never media content.

For 1:1 P2P calls, DTLS-SRTP with fingerprints verified through the E2EE
signalling channel is already end-to-end; we still apply SFrame for
uniformity so that a call can be upgraded to a group call without a key
change.

## 5. Quality & scale features

- **Simulcast** (or SVC with VP9/AV1) so the SFU can forward the right layer
  per receiver.
- Active-speaker detection via audio-level RTP header extension (unencrypted
  by design — a known small metadata leak; document it).
- Last-N video forwarding: at most 16 video tiles at once in a 50-person call.
- Bandwidth estimation (transport-cc / GCC), FEC/RED for audio.
- ICE restart on network change (FR-CALL-8).

## 6. Infrastructure sizing (rough, to validate)

| Item | Rough figure |
|------|--------------|
| 1:1 calls relayed via TURN | ~15–20% of calls (higher if IP-hiding default) |
| Video bitrate per stream | 0.3–1.5 Mbps |
| SFU capacity | ~hundreds of participants per core; benchmark chosen SFU |

## 7. Decisions
- SFU: **LiveKit** (Apache-2.0, self-hostable, browser SDK with E2EE
  support) + **coturn** for TURN — ADR-0006. We drive key management
  ourselves (MLS exporter) instead of LiveKit's shared-passphrase E2EE.
- No server-side recording, ever.

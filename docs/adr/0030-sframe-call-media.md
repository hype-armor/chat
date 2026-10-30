# ADR-0030: SFrame on call media, keyed from MLS, in the core worker

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** project owner, Claude
- **Related requirements:** FR-CALL-3
- **Builds on:** ADR-0006, ADR-0028

## Context
ADR-0006 put SFrame (RFC 9605) on all call media, so group calls through
an SFU stay end-to-end encrypted, with keys from the conversation's MLS
group. 1:1 calls (ADR-0028) are already end-to-end encrypted by DTLS-SRTP
with MLS-authenticated fingerprints; SFrame is added there first so both
call types share one media-encryption design. The ground rules say no
hand-rolled cryptography and no keys on the UI thread, yet WebRTC runs on
the page.

## Decision
1. **The `sframe` crate** (RFC 9605, pure-Rust crypto backend) in
   chat-core, cipher suite AES-128-GCM / SHA-256. No SFrame code of our
   own beyond choosing keys and which bytes stay clear.
2. **Keys from the MLS exporter, per call.** Base key =
   `MLS-Exporter("chat call sframe", call_id, 32)` in the conversation's
   current epoch. The call id as context gives each call its own keys, so
   frame counters restarting in a new call never reuse a nonce. Key IDs
   follow RFC 9605 §5.2: the sender's leaf index (8 bits) and the epoch's
   low 8 bits; each device sends under its own key. When the epoch
   changes mid-call (a device added or removed), both sides install the
   new epoch's keys and keep the previous epoch's receive keys for frames
   in flight.
3. **Frames are encrypted in the core worker.** The page attaches every
   RTP sender and receiver to the core worker: `RTCRtpScriptTransform`
   with the core worker as its worker (Firefox, Safari), or Chromium's
   encoded insertable streams transferred to it. Chromium also has
   `RTCRtpScriptTransform`, but in our tests its receivers never got
   frames, so the older API is used wherever it exists. Keys never reach
   the page.
4. **Video is VP8 only** (codec preferences), with its payload header (10
   bytes on key frames, 3 on others) left readable for the packetizer and
   authenticated as SFrame metadata. Audio (Opus) is encrypted whole.
5. **No unencrypted fallback.** A browser without encoded transforms can't
   call or answer; frames that fail to encrypt or decrypt are dropped,
   never passed on in the clear.

## Consequences
- 1:1 calls carry two layers: DTLS-SRTP hop by hop (end to end here) and
  SFrame end to end. Group calls through LiveKit reuse the same keys and
  transform (Phase 3 item 5).
- Both sides derive keys in the epoch current when their media starts; a
  commit landing between the offer and the answer leaves them a step
  apart until the next key install. Rare in 1:1 conversations; group
  calls will need the epoch in the call signalling.
- No SFrame replay window yet: SRTP's replay protection covers P2P calls;
  group calls through an SFU will add one.
- Encryption costs a wasm call per frame in the core worker (~100 frames
  a second for audio and video together), with an extra copy each way.
- The echo bot (item 4) needs the same keys and transform to answer calls.

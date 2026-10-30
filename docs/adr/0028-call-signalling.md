# ADR-0028: 1:1 call signalling as MLS messages, media peer to peer

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** project owner, Claude
- **Related requirements:** FR-CALL-1, FR-CALL-4, FR-CALL-5, FR-CALL-9
- **Builds on:** ADR-0006 (calls: P2P for 1:1, LiveKit for groups, SFrame)

## Context
ADR-0006 chose peer-to-peer WebRTC for 1:1 calls with STUN/TURN (coturn),
and LiveKit plus SFrame for groups. It left open how the two browsers find
each other: how offers, answers and ICE candidates travel, how a call rings
on every device of the callee and stops once one answers, and where TURN
credentials come from.

WebRTC media is encrypted with DTLS-SRTP, but DTLS only proves that each
side holds the key whose fingerprint is in the SDP. Whoever can change the
SDP in transit can sit in the middle. So the signalling channel decides
whether a P2P call is end-to-end encrypted.

## Decision
1. **Signalling is ordinary MLS application messages** in the 1:1
   conversation: a new `Call` content body (`call_id`, kind `OFFER`,
   `ANSWER`, `CANDIDATE`, `HANGUP`, `DECLINE`, `BUSY`, SDP, candidate,
   `video`, `to_device`). The server can't read or alter SDP, so the DTLS
   fingerprints are authenticated by MLS: the media is end-to-end encrypted
   between the two devices even when it goes through TURN.
2. **Fan-out by kind.** Offers go to every device in the conversation (the
   callee's devices ring; ours learn a call was placed) and are the only
   non-silent call messages, so Web Push wakes a phone. Answers, declines
   and hang-ups also go to every device, so the callee's other devices stop
   ringing ("answered on another device"). Candidates and busy go only to
   the one device they are for (`to_device`); skipping those generations
   is well inside MLS's forward-distance limit.
3. **Mostly non-trickle ICE.** Each side waits up to 2 s for candidate
   gathering and sends them inside its offer or answer; later candidates
   trickle as `CANDIDATE` messages once the other device is known. One
   encrypted message per side in the common case.
4. **Media stays on the page.** `RTCPeerConnection` and `getUserMedia` do
   not exist in workers, so the call screen runs them on the UI thread and
   hands every signal to the core worker, which encrypts and sends it and
   relays incoming ones as events. No MLS key reaches the page; DTLS keys
   are made and kept by the browser.
5. **TURN credentials from the server**: `GET /v1/turn` returns ICE servers
   with coturn REST-API credentials (`use-auth-secret`): username
   `expiry:random`, password base64(HMAC-SHA1(secret, username)), valid
   12 h. The random label keeps the relay's logs from naming accounts.
   Configured by `CHAT_STUN_URLS`, `CHAT_TURN_URLS`, `CHAT_TURN_SECRET`.
6. **Call log on each device**, from the signals it sees: a notice when
   the call ends ("📞 Voice call · 3:21", "Missed voice call", "Declined",
   "No answer", "Line busy"). Missed calls count as unread. Offers more
   than 2 minutes old by the sender's clock (a phone that was off) and
   offers in unaccepted message requests don't ring: they are logged as
   missed. Unanswered calls end as missed after 75 s without a hang-up.
7. **Glare:** if both call each other at once, the call with the lower id
   goes ahead and the other is cancelled. A device already in a call
   answers new offers with `BUSY`; the caller then hangs up everywhere.

## Consequences
- 1:1 calls are end-to-end encrypted without SFrame. SFrame (checklist
  item 3, ADR-0006) is still added for 1:1 calls so both call types share
  one media-encryption design before group calls arrive.
- Without TURN configured, calls work only where host or STUN
  (server-reflexive) candidates connect. coturn deployment and the
  "always relay" privacy setting (FR-CALL-9) are checklist item 2.
- Each signal is a queued message: a device offline during a call gets
  the offer and the hang-up later and only logs a missed call.
- Web Push coalesces wake-ups per device (30 s), so a call shortly after
  another message may not wake a sleeping phone. Revisit with a call-
  specific push if missed calls show up in metrics (item 8).
- The worker's call log is in memory: reloading the page mid-call loses
  that call's notice on this device.

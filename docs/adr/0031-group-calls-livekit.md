# ADR-0031: Group calls: LiveKit rooms per call, tokens for members only

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** project owner, Claude
- **Related requirements:** FR-CALL-2, FR-CALL-3, FR-CALL-6
- **Builds on:** ADR-0006, ADR-0028, ADR-0030

## Context
ADR-0006 chose LiveKit as the SFU for group calls, with SFrame keyed from
MLS. Two questions were open: who may join a room, and what LiveKit learns.

## Decision
1. **One LiveKit room per call**, named by a hash of the conversation id
   and the call id. LiveKit can't tell which conversation a room belongs
   to, nor link two calls of the same conversation.
2. **The chat server issues room tokens** (`POST /v1/calls/join`) only to
   devices that are members of the conversation (the delivery service's
   `conversation_members`, ADR-0017). Tokens last 10 minutes for joining;
   they allow publishing and subscribing but not LiveKit's data channel,
   since everything else goes through MLS.
3. **Participants are named by device id.** LiveKit is our own
   infrastructure and the server already knows device ids; clients map
   them to members through the MLS group.
4. **Whether a call is still going** comes from LiveKit
   (`POST /v1/calls/status`, LiveKit's `ListRooms`), for members only, so
   clients can show "join" without trusting each other's leave messages.
5. **Media stays SFrame-encrypted** (ADR-0030): each browser encrypts with
   its own MLS-derived key in the core worker; LiveKit forwards frames it
   can't read. The keys of every member device are installed, so anyone
   in the conversation who joins can be heard.
6. Configured by `CHAT_LIVEKIT_URL`, `CHAT_LIVEKIT_API_URL`,
   `CHAT_LIVEKIT_API_KEY`, `CHAT_LIVEKIT_API_SECRET`; unset turns group
   calls off.

## Consequences
- LiveKit learns who is in a call (device ids), when, and from where (IP
  addresses), plus audio levels and frame sizes; not the conversation
  or the content (ADR-0006's documented leak).
- A member removed from the conversation stops getting tokens at once,
  and stops being able to decrypt once the epoch changes; a token already
  issued keeps them connected to the room until they leave, hearing only
  ciphertext under the new keys.
- Starting a group call sends an MLS `Call` offer with `group` set and no
  SDP; members get a "join" prompt, and a banner while LiveKit reports
  people in the call. LiveKit's browser client is loaded only when a call
  starts; its own E2EE stays off and every sender and receiver goes
  through the core worker for SFrame. Tracks are published muted and
  unmuted once their sender's transform is attached, so nothing but
  silence and black frames can leave before encryption.

# ADR-0017: Send authorisation by conversation membership

- **Status:** Accepted
- **Date:** 2026-10-29
- **Related requirements:** FR-SAF-2, NFR-SEC-5

## Context
Until now any authenticated device could queue envelopes for any device id.
Device ids are learned by looking up a phone number, so anyone could spam
arbitrary users. The server can't read MLS group state, so it can't check
membership cryptographically.

## Options considered
1. **Per-account access keys** (like Signal's sealed-sender access keys):
   members share a secret, and the server checks a hash. Minimal server
   knowledge, but newcomers and existing members need each other's keys
   before they can talk, and keys must be distributed in-band.
2. **Server-side conversation membership.** The server records which
   devices belong to each conversation id, learned from welcomes, and only
   accepts sends from members to members. Simple and robust. The cost: the
   server persistently stores device ↔ conversation membership. It already
   sees this transiently from delivery metadata.
3. **No server checks; recipients filter.** Spam still costs storage,
   pushes and battery.

## Decision
Option 2 for Phase 1:
- **Welcomes** may start a new conversation (the sender becomes its first
  member) or come from a member, and only reach devices whose key packages
  the sender claimed in the last 7 days. Their recipients become members.
- **Every other envelope** (application, commit, proposal) must come from a
  member and go to members.
- **A commit that adds members carries their welcome** (`SendEnvelope.welcome`).
  The server accepts both in one transaction, so new members are
  reachable before anyone sees the commit. This also removes the race where
  members reacted to a commit before the welcome arrived, and simplifies
  recovering a commit whose answer was lost.
- Removed members stay on the server's list. They can still send noise to
  former groupmates, but clients can't decrypt it.

## Consequences
The server stores conversation membership (device level). Revisit with
option 1 or full sealed sender before public launch (Phase 5); the claim
rule plus lookup and claim rate limits (Phase 1 item 5) bound first-contact
spam.

## Validation
Server tests: strangers and non-member recipients are refused (403);
welcomes need a claim; a commit and its welcome are accepted together and
nothing is accepted without a claim. Browser tests: all chat and group
flows pass in three engines.

# ADR-0035: Mirror group membership changes to the server

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** project owner, Claude
- **Related requirements:** FR-MSG-2, FR-MSG-4, NFR-SEC-1, NFR-SEC-5
- **Builds on:** ADR-0016, ADR-0017, ADR-0031
- **Amends:** ADR-0017 (removed members no longer stay on the server's list)

## Context
The server stores conversation membership at device level, in
`conversation_members` (ADR-0017). It uses that list to authorise sends
and to issue call-room tokens (ADR-0031).

The server cannot read MLS group state. A welcome therefore adds rows,
and nothing removes them except the deletion of a device (ADR-0019) or of
an account. So the list only grew. A device that a commit removed from a
group kept:
- its send authorisation, so it could queue envelopes for the group;
- the right to get a call-room token for the group's calls;
- its place in the list, which made it look like a member.

Clients stayed safe for decryption, because they drop messages from a
sender outside the current roster. But the server needlessly accepted
traffic from a removed device, and the stored list grew without limit.

## Options considered
1. **The server reads the commits.** It needs the group secrets, which
   only members hold. Not possible for a server that does not decrypt.
2. **A separate roster report.** The committer sends the new list to its
   own endpoint after the epoch is accepted. One more round trip, and a
   window where the epoch is new and the list is old.
3. **The commit's send envelope carries the new list.** The server applies
   the list in the same transaction as the epoch advance. No extra round
   trip, and no window between the two changes.

## Decision
Option 3.
- **The committer sends the list.** `SendEnvelope.members` carries the
  device ids of every member after the commit. The committer already has
  them from the group state that it just produced.
- **The server applies it with the epoch advance.** It writes the list to
  `conversation_members` only after the epoch check succeeds, in the same
  transaction. A commit that loses the epoch race changes no membership.
- **The sender must be in the list.** A commit whose list leaves out the
  sender is refused.
- **The server still stores membership.** This ADR only keeps that stored
  list in step with the group. Clients keep the local MLS group as the
  authority for decryption.

## Consequences
- A removed device loses send authorisation and call-room access at once,
  not at its next attempt to join.
- The server trusts the list that the committer sends. That is no more
  than a committer could already do to the group, since a committer
  decides the membership of the next epoch. The gain is that the stored
  list now follows the group instead of only growing.
- A device that removes itself must send a leave proposal, and another
  member commits it, because the server refuses a list without the
  sender. That is the existing leave rule (ADR-0016).
- A wrong list costs delivery, not confidentiality. A client still reads
  only what its own MLS state can decrypt.
- The welcome path still adds rows as before, so a new member is reachable
  from the moment the server accepts the commit and its welcome.

## Validation
Server tests: a commit that drops a device removes its rows. That device
must then get 403 on send and on `POST /v1/calls/join`. A commit that
loses the epoch race leaves membership unchanged, and the server refuses a
list without the sender. Browser tests: remove a member, and the removed
browser can neither send to the group nor join its call.

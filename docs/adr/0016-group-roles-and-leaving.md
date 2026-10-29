# ADR-0016: Group roles, removal and leaving (v1)

- **Status:** Accepted
- **Date:** 2026-10-29
- **Related requirements:** FR-MSG-2, FR-MSG-4

## Context
Groups need owners/admins who can remove people and rename the group, and
members need to be able to leave. The server can't see group membership
(metadata minimisation), so it can't enforce roles. MLS itself has no
roles, and a commit any member creates is cryptographically valid.

## Options considered
1. **Advisory roles, enforced by honest clients.** The admin list travels
   in end-to-end encrypted `GroupInfo` messages. Clients only show admin
   actions to admins, and ignore renames or role changes from non-admins.
   MLS commits from any member are still applied.
2. **Cryptographic enforcement.** Roles in an MLS group-context extension;
   every client validates each commit against them and rejects invalid ones.
   Rejection after the server has ordered a commit forks the group, so this
   also needs server-side cooperation, e.g. members' signatures over
   membership decisions.
3. **Server-enforced roles.** Contradicts minimal server metadata.

## Decision
Option 1 for v1, with a deterministic rule for leaving:
- The creator is the first admin. Admins can rename the group, promote
  members to admin, and remove members (all devices of an account in one
  commit). Any member may add people.
- Leaving sends an MLS self-remove *proposal* (new envelope type
  `PROPOSAL`, which the server delivers without epoch ordering). The
  **first admin in the group's admin list who is still a member** commits
  it. Other clients wait, so concurrent duplicate commits are rare, and
  the server's one-commit-per-epoch rule settles any that happen.
- If no admin remains, members fall back to the member with the lowest
  MLS leaf index.
- A removed or departed member keeps the history but can't send.

## Consequences
A malicious member can still craft a valid removal commit, and
newcomers trust the first `GroupInfo` they receive for the admin list. This
is acceptable for the trusted-group dogfood phase; revisit with option 2
before public launch (Phase 5).

## Validation
Browser test: an admin renames the group and removes a member; a member
leaves, and the admin's client commits the departure.

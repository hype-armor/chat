# ADR-0050: Username changes and account deletion authorization

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Owner; implementation team
- **Related:** ADR-0021, FR-ID-9

## Context

ADR-0021 uses usernames for exact account lookup. It does not provide username
changes. A released former name could identify a different account after a
rename. A deletion flow that checks a cached username can also race with a
rename on another device, after the client has left conversations.

## Options considered

1. Release every former name. This permits reuse, but can misdirect people who
   use an old name.
2. Retire names on rename and release only the current name on account
   deletion. This prevents former-name reassignment, but retains reservations.
3. Keep every name permanently, including the name at account deletion. This
   reduces reuse further, but changes the existing account-deletion policy.

## Decision

Use option 2. A successful rename reserves the new normalized name and
permanently retires the previous name. A retired name cannot be assigned again,
even to its former account or after account deletion. Account deletion releases
only the current name. This updates ADR-0021's assumption that changing a
username is unavailable; its current-name deletion policy remains in effect.
A released current name can later identify a different account. A username is
not a permanent identity or a substitute for safety-number verification.

Rename requests carry an account-scoped request UUID. The server records the
requested name and returns the current identity for an identical retry. Reuse
of the UUID for another name fails. New requests, including no-ops, have an
account-level daily limit. The client persists an uncertain request before
sending and retries it rather than replacing it with a different request.

Devices refresh their own authoritative account name from the server. The
client checks the account ID and active session before storing a response. It
serializes refreshes and rename operations, and retries pending work in the
background. Synchronization is eventual: an offline device can show an old
name until it reconnects and refreshes. It does not update other users' cached
contact names or provide a global rename notification.

For deletion, the client refreshes and confirms the current username before
it leaves conversations. It generates a random 32-byte authorization secret
and persists it in encrypted device storage before preparation. The server
stores only its SHA-256 digest, bound to the account and device, with a 24-hour
expiry. An identical preparation retry remains valid after a rename. Final
deletion uses the authorization, not a second username comparison. The server
rechecks the device and authorization under the account lock. Deletion removes
the authorization with the account. Expiry requires a new confirmation.

This authorization permits one account deletion; it is not an atomic
transaction across conversation departures and account deletion. Departures,
cancellation, and late sends can race or partially complete. A lost final
response can leave the outcome unknown because successful deletion also
removes the device token. Older clients can still submit a username directly;
their departures remain exposed to the rename race.

## Deployment and consequences

Migration `0020_username_legacy_coordination.sql` requires a maintenance
window. Stop all old servers and other account or reservation writers, and
drain their transactions before migration. Start only the new server after
migration. Mixed-version rolling deployment and an ordinary old-binary
rollback are not safe. The trigger fails closed for reserved names, but an old
server can return `500` instead of `409`. Follow the
[deployment procedure](../username-migration-deployment.md), including conflict
handling and rollback constraints.

Permanent reservations reduce impersonation through former-name reuse, but
retain former usernames and account identifiers after deletion. They also
consume the available name space and do not erase names already shared with
others. The current name is reusable after deletion, preserving the earlier
privacy and availability policy at the cost of possible confusion. The server
continues to see usernames and reservation metadata, not message content.
The deletion secret limits stale-confirmation races but does not protect a
compromised authorized device or guarantee complete group departure.

## Validation

Use isolated server tests for concurrent rename, reservation, deletion,
authorization expiry, retry, and device revocation. Use client tests for
session-fenced synchronization, uncertain rename retry, and deletion retry.
Check the migration procedure and old-client limitations before deployment.

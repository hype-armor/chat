# ADR-0051: Invite-only group features and presence

- **Status:** Proposed; implementation and security review required
- **Date:** 2026-11-22
- **Related:** ADR-0016, ADR-0017, ADR-0021, ADR-0035, ADR-0038

## Scope

Groups remain invite-only: an existing member adds participants. A group can
contain multiple named topic channels. Each channel has a visibility toggle:
all group members, or invited channel members only. A group member can
participate in multiple channels. Do not add a public channel directory,
public channel addresses, public self-service join requests, or channel join
keys. IRC interoperability, federation, and IRC commands are also out of scope.

The remaining proposed features are group topics and moderation controls,
optional presence, and changeable account usernames. Existing direct chats
and groups must not gain server-visible metadata or change their privacy
model without an explicit decision. Group topics should remain encrypted.
Presence is off by default. Account username changes must not change the
account ID, device identities, or MLS keys.

## Moderation: unresolved privacy and security trade-off

Existing group roles are advisory (ADR-0016). An MLS member can create a
valid commit, and the server trusts the committer's advertised roster
(ADR-0035). The server cannot prove that an encrypted commit has the
advertised effect. The server cannot distinguish encrypted chat text from
other encrypted application messages. A sender-controlled message-type flag
cannot securely enforce a moderated mode: a modified client can mislabel its
message.

The earlier choice of server-enforced moderation was made for public
channels. It must not be applied automatically to private groups. Server
checks would require additional server-visible group policy or role metadata,
which conflicts with the agreed private-group privacy boundary. Before
implementation, decide whether group moderation should remain advisory or
whether a group may explicitly opt in to a reviewed server-visible policy.

Any stronger design must specify and independently review authorization of
MLS commits, recipient validation, fail-closed handling of malicious commits,
epoch conflicts, recovery, device revocation, and old-client compatibility.
Server acceptance alone cannot prove the encrypted commit's content. Do not
claim strong moderation or invent a cryptographic primitive. A current member
can always share received plaintext; removal cannot erase past copies.
Account bans do not prevent creation of new accounts.

## Remaining feature boundaries

### Group channels, topics and moderation controls

A channel needs its own encrypted conversation and membership state, so
members outside a restricted channel cannot decrypt its messages. An
all-members channel must include the group's current eligible devices and
handle additions and removals without leaving former members access to future
messages. Define how MLS updates complete when the required member is
offline. Show pending or failed synchronization rather than implying success.
A visibility change must explain its membership and history effects; new
members do not receive earlier history by default. Removal cannot erase
plaintext or keys already received. Keep names and topics encrypted. The
server already observes conversation and device membership; multiple encrypted
conversations may reveal additional relationship metadata. The owner accepts
that the server can observe the additional conversation IDs and device
memberships. Restricted-channel existence must not appear in application
messages or the UI for group members outside that channel. Group admins manage
channels under the existing advisory role model; modified clients can bypass
these controls. Honest clients must pause channel sends while a parent-member
removal remains unsynchronized, and show pending or failed status. Review
these rules and their metadata effects before release.

The first restricted-channel slice is an opt-in web build
(`VITE_EXPERIMENTAL_RESTRICTED_CHANNELS=true`). An existing group admin can
create a private child, select current parent members, and later invite more
current parent members. Channel name and parent association travel only in
child MLS ciphertext. No child listing is published to the parent. Honest
clients pause channel traffic if the locally authenticated child roster does
not match the eligible parent devices. The first slice does not remove stale
child devices automatically, provide restored-device admission, or guarantee
that a local roster check sees a commit not yet delivered by the relay.
An invited device can briefly see an unnamed conversation before its encrypted
channel metadata arrives. A non-invited device does not get the child Welcome.

For the real-relay test, build the opt-in web app against disposable test
services and run `E2E_SERVER=1 E2E_RESTRICTED_CHANNELS=1 pnpm exec playwright test restricted-channel.spec.ts`
from `web`. The fixture-only browser suite does not verify relay delivery.

A topic is authenticated, encrypted group state. Define bounded length,
authorized authors, ordering, conflict handling, and an authenticated current
snapshot for newly added members. Do not expose it to the server.

The proposed controls are moderated mode, speaking permission (voice), and
account bans for invite-only groups. Define their exact enforcement and
privacy model before implementation. Removing access requires an MLS
membership change; banning and removal are distinct actions. Test all linked
devices, retries and races. Preserve existing behavior for groups that do not
explicitly enable any new controls.

### Presence

Presence is disabled by default. Explain server-visible and recipient-visible
metadata before activation. Audiences must be explicit and revocable; do not
automatically expose presence to a group. Aggregate per-device state using
short-lived leases. An expired or suspended connection is not proof that a
person is offline; provide an unknown state. Manual away state must not include
message content. Do not store presence in message history, backup, or ordinary
notifications. Handle disconnect, revocation, expiry, sign-out and multiple
devices without leaving stale presence visible. Rate-limit subscriptions and
updates.

The proposed replacement authority is a server registry. It requires an online
check and exposes replacement relationships and timing to the server. Its
rollback protection assumes an honest, durable server and database; it does
not protect against a malicious server or a restored server database. The
registry has an internal experimental store, but it is not integrated. See
[presence replacement persistence blocker](../presence-replacement-persistence-blocker.md).
Presence must remain disabled until the remaining requirements are met and
independently reviewed.

### Username changes

Keep account ID and cryptographic identity unchanged. Normalize usernames as
in ADR-0021 and atomically enforce uniqueness. Rate-limit changes. Resolve
lost responses idempotently and synchronize the current username to linked
devices without trusting stale cached profile data. Names retired by rename remain reserved permanently, including after account
deletion. The current name is released on account deletion under the existing
policy. Never treat a reused name as proof of the old account's identity. Existing chats must remain bound to account IDs and
safety numbers. Recovery and account deletion must use the current username.
Clients must fetch the authoritative current name for each linked device and
bind responses to the active account and session. The server endpoint alone
does not synchronize client caches. Deletion validates the current username
before departures and issues a durable, device- and account-bound authorization.
Renames can proceed after confirmation. The authorization expires after 24 hours;
after expiry, confirm the current username again. Retrying the same authorization
handles a lost confirmation response. A lost final response is ambiguous because
successful deletion also revokes the device. Departures can be partial; cancellation
and late sends are not resolved by this authorization. Old clients still use the
username-only endpoint and retain the rename race. Review this policy before release.

## Verification

Test private-conversation privacy regressions; disabled-by-default presence;
concurrent commits, bans and role changes; untrusted and outdated clients;
all-device removal; retry and crash recovery; account rename collisions and
reuse; and abuse limits. Run fast format, lint, type and focused unit checks
first, then isolated database integration tests and browser tests. Tests do
not replace an independent security review or prove that malicious clients
comply.

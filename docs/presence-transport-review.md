# Presence transport review: activation blockers

This is a design review aid, not an implemented protocol. Presence remains off.
The existing WebSocket `SendEnvelope` path writes to the durable delivery queue.
It must not carry presence. The existing per-process hub is not a cross-replica
consent or revocation mechanism. A recipient-side lease aggregator is not an
authorization mechanism.

## Required authority and disclosure

A future server authorization service needs a durable, account-bound consent
version and an explicit set of recipient account IDs. An empty set is the
initial state. Updates must use an expected version, so an old device cannot
replace newer consent. A failed version check must not retry as an unconditional
write. A backup or device restore must not replace this authority. The service
must authenticate the current device again within the authorization transaction
and serialize consent changes across replicas. Device removal and account
deletion must participate in the same ordering or invalidate the device before
any later operation can succeed. Regrant must use a new generation.

This model reveals the selected account relationships and changes to them to
the server. A transport can additionally reveal device identities, timing,
frequency, connection state, and possibly status and expiry. It must state
exactly which fields the server sees before activation. Recipient accounts can
observe their own grants, updates, and timing; they must not receive the rest
of the audience. A user must choose individual recipients and see this disclosure
before granting access. Do not infer grants from group membership.

## Revocation and delivery boundary

A database check followed by a socket write is not atomic with a concurrent
revocation. A local mutex does not solve this across replicas. A future design
must define a shared ordering point for revocation, active-device validation,
and every delivery, including any inter-replica channel and socket output
buffer. It must specify the failure behavior when a replica loses contact with
that ordering authority. It must not use a durable queue, push, or a history
path for presence.

Bytes already handed to a network or a recipient before revocation cannot be
recalled. The protocol must distinguish that unavoidable case from a delivery
newly authorized after revocation. Recipient clients must fence events by the
current authenticated consent generation, including revoke-then-regrant and
late packets. The design must define how a recipient learns the current
generation without relying on an old or forgeable event. A connection that
cannot establish current authorization must show unknown, not accept a cached
lease as current authority.

## Work needed before implementation can be enabled

- Specify account/device authentication and encrypted, authenticated event
  bindings for sender, recipient, generation, state, and expiry. Reuse a
  reviewed protocol; do not invent cryptography.
- Specify cross-replica revocation ordering and the exact delivery linearization
  point, including socket buffers, crash recovery, partitions, and device removal.
- Define bounded audience and subscription limits, update rate limits, short
  leases, clock skew, and per-device aggregation. Expiry means unknown.
- Specify cross-device consent conflicts, sign-out, offline devices, and backup
  restoration. A delayed device must not re-enable a revoked grant.
- Test the actual transport with multiple server replicas and real database
  transactions: concurrent sends and revokes, queued and delayed packets,
  regrant, device removal, disconnection, and failure of the shared authority.
  Check that no presence data enters queue, history, backup, or notifications.
- Obtain independent privacy and security review before activation.

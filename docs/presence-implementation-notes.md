# Presence implementation notes

ADR-0051 defines the privacy boundary. Presence is not implemented end to end.
`web/src/core/presence.ts` contains only an unused recipient-side lease
aggregator. It does not enable presence or authorize anyone to see it.

`PresenceEvent` in `proto/chat/v1/content.proto` and the validator in
`crates/chat-core/src/presence.rs` define an experimental payload. A focused
native test encrypts it with an OpenMLS application message and verifies the
MLS sender. The payload binds the selected conversation, recipient account,
consent generation, state and expiry. The MLS credential supplies the sender
account and device. The validator rejects a roster with accounts other than
those two accounts. It does not establish that the conversation was explicitly
selected, or that the consent generation is current.

Presence now has an experimental `Content` body and native core encode/decode
primitives. `Client::receive` ignores this body, and `Client::send` rejects it.
The separate receive primitive requires a current authenticated sender account,
grant generation, selected conversation, and clock from its caller. It returns
the MLS-authenticated device identity. The caller must persist MLS state after
all receive attempts, including invalid events, and before publishing ciphertext.
These primitives are not exposed in WASM and do not authorize transport. A
separate transport must coordinate MLS ratchet state with ordinary conversation
traffic, including loss and reordering. Do not send presence through
`SendEnvelope` or enable the UI.

A proposed separate transport can store short-lived ciphertext leases and
perform database-backed audience checks. The server would see the selected
account relationships, device identities, request timing and ciphertext lease
timing, but not the encrypted state or its encrypted expiry. Database
transactions must order authorization with audience changes and device removal.
Revocation stops requests authorized after the revocation transaction; a
response authorized before revocation can arrive afterward. Recipients must
obtain current authorization and reject old generations. No such transport or
authority is implemented yet. Limits, cleanup, concurrent replicas, failures,
and an independent security review remain required before activation.

## Requirements for integration

- Default sharing to off for every account and every device. Ask the user to
  select individual recipient accounts before sending. Never derive the audience
  from group membership. Explain what recipients and the server can observe.
- The audience and revocation state need authenticated, account-bound handling
  across devices. An old device, delayed operation, or restored backup must not
  silently re-enable sharing or restore a revoked recipient. Specify conflict,
  device revocation, sign-out, and offline-device behavior before activation.
- Use an authenticated ephemeral transport. Bind the sender account and device,
  recipient, audience generation, status, and expiry to the authenticated event.
  Do not put presence in durable delivery queues, message history, backups,
  notifications, or normal conversation messages. Do not reveal a group audience.
- The server must enforce subscription and update limits and must not expose
  presence to an unauthorized account. Define the server-visible relationship,
  timing, and status metadata. Ensure revocation and send authorization are
  ordered atomically, including concurrent requests and multiple server replicas.
  Prevent queued or in-flight stale updates from reviving revoked consent.
- Authenticate the current device roster and audience generation before each
  update and read. Fence asynchronous callbacks on account, device, connection,
  and consent changes. After revocation, ignore old-generation events even if
  they arrive after a new grant. Stop publication on sign-out or disconnect.
- Refresh short leases only while authorized. Expiry means unknown, not offline.
  Across active devices, online wins over away; away applies only when no live
  device reports online. Explicit stop, suspend, and connection loss cannot prove
  that all devices are offline. Schedule UI expiry even when no event arrives.
- Bound the number of tracked accounts and devices and reject malformed events.
  Use a clock that advances during wall-clock rollback. Event timestamps and
  expiry require authenticated values and bounded skew. Test delayed, duplicate,
  reordered, revoked, and cross-account events and clock jumps.
- Review the complete protocol and its metadata exposure independently before
  enabling this feature. The pure lease tests do not establish transport security.

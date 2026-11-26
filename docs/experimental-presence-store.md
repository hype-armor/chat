# Experimental presence store (not enabled)

An explicitly gated experimental HTTP polling transport uses these primitives.
See [experimental presence transport](experimental-presence-transport.md).
Clients and UI must not use it before independent privacy and security review.
It is not a complete transport. Each operation verifies the bearer token against the device
inside its authorization transaction. Each attempt that reaches a store operation
uses a separate, committed rate counter, including rejected writes. Malformed
JSON and requests rejected before the store are not counted. Grants are limited to 100 per
sender, and each grant has at most 10 leases of at most 8192 bytes each. Polls
request one sender at a time; there is no subscription API or subscription state.
A production transport must add bounded subscriptions if it adds subscriptions,
further abuse tests, recipient reconciliation and MLS
generation fencing. It must handle database errors by
showing unknown. It must not fall back to the durable queue.

The server can see selected sender and recipient account relationships, device
identities, consent changes and generations, ciphertext sizes, lease expiry,
and update and poll timing. Recipients can see the sender device IDs,
generation, ciphertext and their timing. The ciphertext is opaque to the
server; only authenticated MLS recipients may interpret it. A user must see
this disclosure and select individual recipients before any activation.

Account recovery retains the previously selected account-scoped audience. Recovered
devices may resume sharing with that audience. Recovery removes old devices and
their leases; it does not reset consent. The restored device must reconcile the
current server version and grants before it publishes or changes consent.

A poll locks the current grant in its transaction. Revocation waits for an
earlier authorized poll. That poll may return after revocation commits. A poll
that obtains authorization after revocation sees no grant. Revocation removes
leases, and regrant uses a new account-wide generation. Clients must not accept
an old generation after learning the current one. Expiry means unknown, not
offline. No network delivery or socket buffer is covered by these primitives.

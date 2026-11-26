# Experimental presence polling transport

This transport is incomplete and must not be enabled for production. Set
`CHAT_EXPERIMENTAL_PRESENCE=true` to enable the routes. The default is off.
Independent privacy and security review and client consent UI are required.

The server sees selected sender and recipient account relationships, device
identities, consent changes and generations, ciphertext sizes, lease expiry,
and update and poll timing. Recipients see sender device IDs, generations,
ciphertext and timing. The server cannot verify that submitted bytes are MLS
ciphertext. Clients must use authenticated MLS and bind sender, recipient,
generation, state and expiry. A user must see this disclosure and select each
recipient before activation. Never infer audiences from group membership.

All requests use a bearer token and JSON. Each supplies its own `device_id`.
`POST /v1/experimental/presence/grant` takes `recipient`, `expected` account
version and `enabled`; it returns `version`. `POST
/v1/experimental/presence/lease` takes `recipient`, `generation`, and standard
base64 `ciphertext`. `POST /v1/experimental/presence/poll` takes one `sender`
and returns an array of `device_id`, `generation`, and base64 `ciphertext`.
`POST /v1/experimental/presence/consent` takes `device_id` and returns the
current account `version` and `grants` array of `recipient` and `generation`.
An account with no grants returns an empty array. `POST
/v1/experimental/presence/generation` takes `device_id` and `sender`, and
returns the current `generation` or null for the authenticated recipient.
These reads share the polling rate limit. Generations are safe JSON integers;
the experimental client adapter must validate them and convert them to canonical
decimal strings before reconciliation.

Responses use `Cache-Control: no-store`. The transport never uses the durable
message queue. A lease expires after 60 seconds; expiry means unknown, not
offline. The server schedules cleanup every 60 seconds while enabled.

A poll locks the grant at authorization. A poll authorized before revocation
can return after revocation commits. A poll authorized afterward returns no
lease. Network buffers and bytes already delivered cannot be recalled. Regrant
uses a new generation. Database errors mean unknown. Clients must not fall
back to message history or the durable queue.

The read endpoints and experimental client helpers are not integrated into the
app. The client must independently read the current generation after each poll,
and show unknown on failures. A read authorized before revocation can return
later and cannot recall delivered bytes. The store limits authenticated operations, but malformed JSON and
requests rejected before the store are not counted. Multi-replica abuse and
transport race tests and independent review remain necessary. Do not treat an
empty poll as proof of current generation or offline state.

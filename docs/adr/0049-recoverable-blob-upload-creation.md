# ADR-0049: Recoverable multipart upload creation

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Owner; implementation team
- **Related requirements:** FR-MED-2, FR-MED-3, NFR-SEC

## Context

A client can lose the response after it starts a multipart upload. A retry of
`POST /v1/blobs/uploads` currently creates another session, consumes another
daily upload allowance, and reserves another ciphertext object set. A client
can also lose the completion response after the server deletes the session.

The server must remain ciphertext-only. It must not store file names, MIME
types, plaintext hashes, peers, outbox identifiers, or message metadata.
ADR-0040 requires quota reservations before object-store I/O and requires
release only after confirmed deletion and writer fencing.

## Options considered

1. Generate a server idempotency key. The client cannot recover it after a
   lost create response.
2. Use a caller-generated opaque transfer UUID, bound to immutable ciphertext
   size and digest. The client can persist and query it after interruption.
3. Use the ciphertext digest as the object identity. This exposes a stable
   cross-device correlation key and changes existing object semantics.

## Decision

Use option 2. New clients generate a random UUID `transfer_id` and persist it
with the ciphertext SHA-256 before their first create request. The JSON digest
uses lowercase 64-hex, as the shared media-transfer contract requires. Both
fields are optional as a pair so legacy clients keep the existing request form.

The server stores only `transfer_id`, device id, ciphertext size, the normalized
32-byte ciphertext SHA-256, upload id, optional blob id, and an opaque lifecycle state.
The transfer key is `(device_id, transfer_id)`. A matching retry returns its
original upload id without another daily or storage quota debit. A changed size
or digest gives `409`. Another device cannot look up this device's transfer,
but may use the same random UUID for its own independent transfer.

`GET /v1/blobs/capabilities` advertises
`{transferIdempotency: 1}`. `GET /v1/blobs/transfers/{transfer_id}` returns
`{state: "uploading", upload_id}` or `{state: "complete", blob_id}`.
Expired transfers return `409` and remain as replay fences.

Completion first commits a random durable claim on the upload row. Part
writers and expiry reject or skip a live claim. It then hashes stored parts in
order through 1 MiB range reads outside every database transaction. A second
transaction must find the same claim and revalidate ready ledger entries before
it creates the blob, promotes ledger entries, or records the transfer-to-blob
mapping. A stale claim permits only a fresh hash and re-lock pass; it never
publishes by lease expiry alone. Completion retries use the mapping after the
multipart session is deleted. Expiry changes a transfer to `expired` only after
confirmed object deletion. The retained row never permits a new upload under
the same transfer id.

## Consequences

Clients must persist a random UUID and ciphertext digest before network I/O to
receive recoverable semantics. The server retains small opaque transfer fences
past session and blob expiry. This is deliberate quota and replay metadata,
not attachment content metadata.

The create transaction serializes the `(device_id, transfer_id)` key before
charging the daily budget or reserving object keys. It also takes the shared storage policy lock.
No object store operation occurs in that transaction.

## Validation

Use isolated PostgreSQL tests for lost create, lost completion, concurrent
same-device transfer create, same-UUID cross-device independence, changed
parameters, cross-device lookup, quota limits, and expiry tombstones. Test concurrent part writing, completion, expiry, and
stale-claim recovery. Confirm one reservation and one object-key set exist for
every transfer UUID.

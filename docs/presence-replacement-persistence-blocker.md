# Presence replacement persistence blocker

Presence replacement remains disabled. The replacement validator is experimental;
it does not join groups, persist fences, or authorize sending.

## Findings

`Client::snapshot` and `Client::restore` serialize the local MLS client. The web
worker can atomically write encrypted records with `SecureStore.putBatch` or
`updateBatch`, after it seals the values. A completed IndexedDB transaction
can therefore commit a client snapshot and a fence together. It cannot prevent
an old database or an old snapshot from being restored. A joined group in memory
must not become usable before the transaction commits. On an abort or an
ambiguous transaction outcome, the worker must stop using that in-memory client
and recover from durable state. A retry must revalidate the authenticated binding,
the complete roster, the grant, and the account/device lifecycle under the MLS
mutation lock. A join that consumes a key package also needs a durable recovery
protocol; an atomic final write alone does not establish safe retry after a crash.

The server's experimental consent generation orders grants and revocations. It
does not order replacement generations or group IDs. A replacement can occur
without changing consent. Thus a current consent generation cannot detect an old
replacement fence. DeviceSync transports authenticated data from another device,
but it is asynchronous and can be delayed, missing, or restored with old state.
It is not an independent monotonic replacement authority. No current independent
authority for the replacement fence has been established. An internal experimental
PostgreSQL registry now implements the selected server direction. It is not
integrated into any route or client and is not an active authority.

A local fence retains all used group IDs, not only the latest one. Otherwise an
A-to-B-to-A replacement with a higher generation can reuse A. Its finite capacity
fails closed; it must not discard old IDs. This local measure does not prevent
rollback of the entire fence. A missing, malformed, incomplete, or rolled-back
fence must not be treated as proof that a group is new. The default empty fence
is only suitable for a separately authenticated first-use protocol, which does
not exist yet.

## Selected direction and limits

The proposed PostgreSQL registry requires online checks. The server can observe
the participating accounts and devices, direct-conversation identifiers,
replacement identifiers, and replacement and check timing. It must not receive
plaintext presence status. Protection assumes an honest server with durable
state and no database rollback. A malicious server or restored database can
accept an old state. This is not protection against either case.

The registry must retain group-ID reuse fences across grant revocation, device
revocation, and account recovery. A retry of a committed operation must fail if
another operation has since replaced its result. Retention requires an explicit
storage and account-deletion policy; capacity exhaustion must fail closed rather
than discard fences. Recovery must not reset fences for a surviving account.

An authority response is only a point-in-time check. A later replacement or
revocation can occur before the client uses a group. The client must address this
TOCTOU window and revalidate lifecycle and roster state. The registry alone does
not integrate the client, solve join crash recovery, or authorize MLS state.
Network errors, ambiguous outcomes, stale responses, and missing or incomplete
state must leave the group unusable.

## Experimental store

Migration `0022_experimental_presence_replacement.sql` adds scoped state and
retained operation and group-ID history. The internal store serializes changes
per sender device, compares generations atomically, and locks the current grant
through each transaction. It retains history across grant and device deletion.
It limits each device to 1,024 scopes and each scope to 1,024 replacements;
exhaustion fails closed. A retry succeeds only for the exact operation while its
result remains current. Reads are point-in-time checks. Database rollback or a
malicious server defeats these guarantees.

The store is not reachable through a route and does not enable presence. Its
caller supplies the direct-conversation identifier: the store does not verify its
membership, uniqueness, or authenticated first use. Before any integration, define
and verify those properties, bind the registry to MLS and lifecycle checks, and
solve client join recovery and the check-to-use race. Device replacement or account
recovery can create a new scope; no protocol yet transfers or binds old fences to
the recovered identity. The retained rows have no cascading foreign keys. Their
account deletion, privacy, storage retention, and capacity policies require review.
The internal primitives are not an authorization boundary or a complete protocol.

## Required before integration

Define and review an independent monotonic authority bound to the sender device,
recipient account, direct conversation, replacement generation and used group
IDs, including authenticated first use and concurrent replacement. Specify its
privacy and availability effects. Also define recovery after join and before
commit, lost commit responses, account switch, sign-out, device revocation,
grant revocation and regrant, and offline or restored devices. Revalidate all
lifecycle and roster state before publishing and after asynchronous work. Do not
delete replay fences on revocation. A failed authority read must keep the group
unusable. Add real crash, transaction-abort, replay, and rollback integration
tests once that protocol exists. The validator tests do not establish these
properties. Independent security review is required before activation.

# ADR-0034: Bind MLS identities to account and device

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** project owner, Claude
- **Related requirements:** FR-ID-2, FR-ID-5, NFR-SEC-1
- **Builds on:** ADR-0002, ADR-0019, ADR-0020

## Context
The MLS basic credential identity is 32 bytes: the 16-byte account id,
then the 16-byte device id (`makeIdentity` in `web/src/core/ids.ts`). Every
member leaf carries this identity, and clients read the account from its
first 16 bytes.

A key package carries the credential of the device that made it. No client
compared that identity with the account and the device that own the
package. A user could therefore put the account id of another user into
their own package. When a group added that package, the group got a leaf
that claimed to be the other account. The attacker then got:
- application messages that every client attributes to the other account;
- `DeviceSync` content that the other account applies as its own, which
  replaces its blocked list, contact names and conversation names;
- the right to act as that account in every group that holds the leaf.

## Options considered
1. **Trust the server's device records.** The server knows which account
   owns a device. But the server is not trusted (NFR-SEC-1), and the check
   must also cover packages that another client sends.
2. **Check the identity in chat-core against the bytes the caller
   expects.** The caller knows the account and the device before it adds a
   package. The check is cheap and every add path uses it.
3. **Rely on safety numbers.** They find a substituted key after the fact,
   and only when two people compare (ADR-0020). They do not keep a forged
   identity out of a group.

## Decision
Option 2, plus one rule in the engine.
- **Length check.** The wasm layer refuses an expected identity that is
  not exactly 32 bytes, and the browser makes every identity with
  `makeIdentity`, so an account id and a device id always sit in 16 bytes
  each.
- **Binding check.** Before a key package enters a group, chat-core
  compares its credential identity with the expected bytes: account id,
  then device id. `addMembers` and `startConversation` take one expected
  identity per package, in the same order. A mismatch fails the call, so
  no commit and no welcome are made.
- **Pre-check in the worker.** The wasm layer exposes
  `keyPackageIdentity` (package bytes in, identity bytes out). The worker
  reads the identity of each package before it builds an invite, and
  reports a bad package instead of adding it.
- **DeviceSync sender.** The engine applies `DeviceSync` content only when
  the sender identity belongs to one of the account's own devices.

## Consequences
- A forged leaf cannot enter a new group. The add fails at the committer,
  which learns that the package is wrong.
- Existing groups keep their members. The check runs when a package
  enters a group, and a leaf that is already stored is not checked again.
  A forged member that is already in a group must be removed in the usual
  way (ADR-0016).
- The committer needs the account id and the device id of each invitee
  next to the key package. The engine already has both from the claim
  response.
- Safety numbers still detect key substitution out of band. Key
  transparency stays future work (ADR-0020, doc 04).

## Validation
Core tests: a package that carries another account's id is refused, and a
package that matches the expected bytes still joins. Wasm tests: an
expected identity that is not 32 bytes is refused, and `keyPackageIdentity`
returns the identity of a package. Engine test: the engine does not apply
a `DeviceSync` message from a device of another account. Browser tests:
invite, add, remove and link flows still pass in three engines.

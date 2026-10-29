# ADR-0020: Safety numbers and key-change warnings

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** project owner, Claude
- **Related requirements:** FR-ID-5, FR-ID-6; doc 04 §1 (key-substitution resistance)

## Context
The server's key directory says which devices belong to an account
(ADR-0011, ADR-0019). A malicious or compromised server could hand out its
own key packages, or link its own device to someone's account, and read
new messages. MLS authenticates devices, not people. Users need:
- a way to check, out of band, that they see each other's real devices;
- a warning when that set changes.

## Options considered
1. **Per-device fingerprints.** Precise, but unusable with several
   devices per person; people compare once, not per browser.
2. **One safety number per pair of accounts**, over each account's sorted
   device signature keys. This is Signal's numeric fingerprint
   construction: version, keys and account id, hashed with SHA-512 5,200
   times, giving 30 digits per account and 60 for the pair. A device
   change on either side changes the number.
3. **Key transparency** (an auditable log). It is the stronger, automatic
   defence, and a Should in doc 04. It needs log infrastructure; it
   complements (2) later rather than replacing it.

## Decision
Option 2, computed in the Rust core from the MLS leaves' signature keys
of a conversation both people are in, so both sides hash the same keys.

- **Comparing:** people compare the 60 digits (12 groups of 5) in person or
  over a call. Alternatively, one scans the other's QR code
  (`chat-verify:v1:<digits>`), and a match marks the contact verified.
- **Verifying:** stores the contact's device keys at that moment.
- **Change warnings.** Each device remembers every key it has seen per
  account. When a key it has never seen appears for an account it already
  knew, it:
  - adds a notice to every conversation with that person ("X's safety
    number changed: a device was added");
  - shows "changed" instead of "verified" if the person was verified.
  
  Removed devices are not warned about; they cannot read anything new.
- **New devices on one's own account** raise an alert ("A new device was
  added to your account") unless this device approved that link itself.
  This catches a server that links its own device to the account.

## Consequences
- The first contact is trusted on first use, as in every messenger without
  key transparency. Verification is what upgrades it.
- Every legitimate new device of a contact also triggers a warning. That is
  intended: it is the same event an attack would produce.
- History of keys is local. A new device starts with an empty key book and
  does not warn about keys it first sees.

## Validation
End-to-end test: both sides see the same number, and verification shows.
When the contact links a laptop, the other side gets a notice and the
verified mark turns to "changed".

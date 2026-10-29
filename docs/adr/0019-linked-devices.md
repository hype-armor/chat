# ADR-0019: Linked devices

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** project owner, Claude
- **Related requirements:** FR-ID-2, FR-ID-3, FR-ID-4, FR-MSG-13

## Context
An account may have several devices (browsers, installed PWAs; up to
`MAX_DEVICES_PER_ACCOUNT`), each a separate MLS member with its own keys
(FR-ID-2, FR-ID-3). Verifying the phone number again on a new browser
already registers another device for the same account. Nothing yet:

- lets a user add a device without another SMS (cost, and SMS is the
  weakest part of sign-up);
- puts a new device into the account's existing conversations, or puts a
  user's other devices into new conversations;
- shows messages sent from one's other devices as one's own;
- lets a user see and remove devices (FR-ID-4).

## Options considered
1. **Signal-style provisioning.** The new device shows a QR code with an
   ephemeral public key. The old device sends it the account's secrets
   encrypted to that key, through a server relay. Needs an HPKE channel
   beside MLS and a second encrypted format for synced state.
2. **Server-approved link plus MLS for everything else.** The QR code holds
   a one-time link code. The old device approves it, the server registers
   the new device for that account, and the account's devices then talk
   over MLS like any members. Synced state travels in an MLS group made of
   the account's own devices.
3. **SMS only.** No QR code; every device verifies the number. Simple, but
   it costs an SMS per device, and SIM-swap attackers get a device just as
   easily.

## Decision
Option 2.

**Linking.**
1. The new device asks the server for a link code: 128 random bits. The
   server stores only its SHA-256, and the code expires after 10 minutes.
2. The new device shows the code as a QR code and as text for typing.
3. A signed-in device scans or types the code. The user confirms "This
   device will receive all your new messages", and the device approves the
   code with its token.
4. The new device polls with the code. Once the code is approved, the
   server creates the device under that account and returns its token, as
   phone verification does. A code can be used once.

**Membership.** Every device keeps its account's devices (`GET
/v1/devices`) in each of the account's conversations:
- It adds own devices missing from a group, and removes own devices that
  no longer exist.
- New conversations include the creator's other devices from the start.
- Only one device acts per group: the account's device with the lowest
  leaf index in that group. That keeps devices from racing each other and
  wasting key packages.
- Other members accept these commits whatever their group role, because
  they only add or remove devices of the committer's own account.

**Self-sync.** The account's devices share a hidden *self* conversation
(an MLS group of only those devices). It carries `DeviceSync` messages:
- display name;
- contact names and phone numbers;
- each conversation's name and admin list.

A new device learns these when it joins. Messages a user sends from one
device reach their other devices through the conversation's MLS group like
anyone else's, and show as "me".

**Leaving.** Leaving a group from one device makes the account's other
devices propose their own removal too.

**Removing a device.** `POST /v1/devices/remove`, for another device of
the same account:
- the server deletes that device with its token, queue, key packages and
  memberships;
- the remaining devices then commit its removal from every group.

Until those commits land, the server drops deleted devices from a send's
recipients instead of refusing the send (ADR-0017 still refuses existing
non-members).

## Consequences
- The server decides which devices belong to an account. A malicious
  server could add a device to someone's account and read their future
  messages. That is the general key-directory trust problem; safety
  numbers and key-change warnings (FR-ID-5/6, roadmap item 9) are the
  defence. They will cover device additions too.
- Approving a code is powerful. Social engineering ("scan this QR code")
  links the attacker's device, so the approval screen states the
  consequence plainly, and the device list shows every device with the
  day it was added.
- No message history moves to a new device. Encrypted backup (ADR-0010)
  covers history later.
- Each group gets up to `MAX_DEVICES_PER_ACCOUNT` leaves per member; the
  50-person limit counts accounts, not devices.

## Validation
End-to-end test: link a second browser by typing the code. It receives
messages from a contact in an existing conversation, and sees messages
sent from the first browser as its own. Removing it from the first
browser stops delivery to it.

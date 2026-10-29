# ADR-0022: Backup, restore and member device sync

- **Status:** Accepted (refines ADR-0010)
- **Date:** 2026-10-29
- **Deciders:** project owner, Claude
- **Related requirements:** FR-MSG-13, FR-ID-3, FR-ID-6, FR-ID-9

## Context
Since ADR-0021 there is no phone number to recover an account with, and
browsers can evict storage. ADR-0010 chose an encrypted backup under a
user-held recovery key but left two questions open: what to back up, and
how a restored device gets back into its conversations.

MLS makes the second hard. Restoring an old copy of a device's group state
is unsafe and usually useless:
- groups move to new epochs after the snapshot;
- the server deletes envelopes once a device acks them;
- reusing old key material undermines forward secrecy.

## Options considered
1. **Back up the full device state (MLS included) often.** Fragile: any
   envelope acked after the last upload leaves the restored state behind
   its groups, and the groups break.
2. **Back up history and metadata; restore as a new device that members
   re-add.** Works with MLS as designed: a new member gets a welcome to the
   current epoch.
3. **MLS external commits** (the restored device joins from published
   GroupInfo). Needs a GroupInfo per group kept current on the server.
   It is a later optimisation of option 2.

## Decision
Option 2.

**Recovery key.** 128 random bits shown once as 26 base32 characters in
groups (`ABCD-EFGH-…`), instead of the word list ADR-0010 mentioned. From
it, HKDF-SHA256 (WebCrypto) derives:
- an *encryption key* (AES-256-GCM) for the backup;
- an *auth secret*. The server stores only SHA-256 of the auth secret, to
  check restores.

**Backup contents.** The device's view of the account, encrypted and
gzip-compressed on the device:
- conversations and their messages;
- names, usernames, group names and admins;
- blocks and safety-number verifications.

It never includes MLS state, device keys or tokens.

**Backup schedule.** Uploaded after changes (debounced), at most every 10
minutes, and on demand. The server keeps the latest per account (25 MB cap
while backups live in PostgreSQL; Phase 2 item 9 moves them to blob
storage).

**Restore.** On a new browser, the user enters username and recovery key.
The client proves the auth secret, and the server then:
- deletes the account's other devices, since the user lost them or is
  taking the account back;
- registers this one as a fresh device;
- returns the backup.

The client decrypts it and shows the history, while its conversations wait
to be rejoined.

**Rejoining: members keep every member's devices.** Every device compares,
for each group it is in, each member account's devices on the server
(`POST /v1/devices/of`) with that account's leaves:
- it adds missing devices and removes deleted ones;
- per account, the account's own lowest leaf acts if it has one in the
  group; otherwise the group's lowest-leaf member acts;
- checks run on connect and every 10 minutes.

So a restored device is added back by its contacts. The same mechanism
removes a deleted account's leftover leaves, and adds a contact's new linked
device even when that contact's other devices are offline. Peers'
safety-number warnings (ADR-0020) flag every such addition, which is how a
server injecting devices would show.

## Consequences
- **Gap:** messages that arrive between the last backup and the rejoin are
  not delivered to the restored device. Those that arrived before its old
  devices were deleted are in nobody's backup.
- **Recovery key = account:** whoever has the recovery key and the username
  can take over the account. The key is shown once, never sent to the
  server, and the user is told to store it offline.
- **Losing the key:** losing both the devices and the key loses the account,
  by design (ADR-0010).
- **Server load:** the server learns nothing new: it already knows group
  membership (ADR-0017). Restores are rate-limited per IP and per account.

## Validation
- **End to end:** set up a backup, wipe the browser, restore by username
  and recovery key. History is back; a contact's app re-adds the device;
  messages flow both ways.
- **Server tests:** restore needs the right proof; it deletes the old
  devices; it is rate-limited.

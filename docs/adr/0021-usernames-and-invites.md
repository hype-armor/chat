# ADR-0021: Usernames and invite-only sign-up

- **Status:** Accepted (supersedes ADR-0011)
- **Date:** 2026-10-29
- **Deciders:** project owner, Claude
- **Related requirements:** FR-ID-1, FR-ID-1a, FR-ID-7, FR-SAF-2, NFR-LEG-5

## Context
ADR-0011 made the phone number the account identifier, verified by SMS.
The owner no longer wants phone verification. Its costs were:
- SMS fees and SMS-pumping fraud;
- SIM-swap account takeover;
- US texting registration (10DLC);
- the server holding every user's phone number.

Encryption never depended on it: each device has its own keys (FR-ID-2),
and devices join an account by QR code (ADR-0019). Phone numbers served only
sign-up and finding people.

## Options considered
1. **Usernames:** a chosen handle, found by exact search, QR code or link.
   No personal data, but accounts cost nothing to create.
2. **Invite-only sign-up:** an invite from an existing user is needed to
   register. Strong spam control while the user base is small.
3. **Email codes:** like SMS but cheap. Still personal data, and
   disposable addresses defeat it.
4. **No identifier** (Session/Threema style): random IDs only. Hard to
   share and to remember.
5. **Sign in with Google/Apple:** shares data with them and needs their
   scripts, which our CSP forbids.

## Decision
Options 1 and 2 together.

- **Username:** `name.NN`. The name is 3–20 characters, starting with a
  letter (`a–z`, `0–9`, `_`), then a dot and 2–4 digits, for example
  `alex.27`.
  - The digits limit name-squatting and make usernames harder to guess.
    The app suggests them.
  - Usernames are unique and case-insensitive (stored lowercase).
  - A deleted account's username becomes free again.
  - Others see the display name in chats. The username is only for
    finding someone.
- **Sign-up:** `POST /v1/register` with username, display name (client-side
  only), identity key and, in invite mode, an invite code. No secret is
  sent: the device token is the credential, as before.
- **Invites:**
  - single use, valid 7 days, 16 random bytes stored as a hash;
  - shared as a link (`https://<host>/#invite=<code>`) or its QR code;
  - each account may hold 5 unused invites and create 10 a day;
  - the operator creates the first one with `chat-server create-invite`.
- **Who invited whom is not recorded:** an invite row is deleted when used.
  Recording it would put the social graph on the server, against the
  "no extra metadata" rule. Abuse is handled per account (rate limits,
  reports, message requests) rather than per invite chain.
- **Modes:** `CHAT_REGISTRATION=invite` (default) or `open` (development
  and tests). Open sign-up for production later gets proof-of-work in
  front of it (doc 09).
- **Finding people:** `POST /v1/lookup {username}` with the existing
  per-device rate limit, exact match only (no search or listing). Also
  invite links and the safety-number QR codes.

## Consequences
- **No contact-book discovery** (FR-ID-7 is dropped): people share
  usernames or invite links.
- **No recovery by phone:** losing every device loses the account. Linked
  devices and the encrypted backup with a recovery key (ADR-0010) are the
  recovery path, so the backup moves up in priority.
- **Simpler and cheaper to run:** the SMS code, SMS provider, SMS-pumping
  limits and the phone column are removed. Roadmap item 16 (SMS provider)
  is gone.
- Usernames are public handles once shared; people can pick a new
  account if one leaks. (Changing usernames: a later addition.)

## Validation
- **Server tests:**
  - invite mode refuses sign-up without a valid, unused, unexpired invite;
  - invites are single-use and limited per account;
  - usernames are validated and unique;
  - lookup works by username.
- **Browser tests:** sign-up by username; an invite link created by one user
  signs up another, who can then message them.

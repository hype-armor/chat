# 11 — Server API (v1)

**Status:** Implemented in `crates/chat-server` (Phase 1, in progress).

REST endpoints take and return JSON. Binary values (keys, key packages) are
standard base64. Errors are `{"error": "<message>"}` with an HTTP status.
Authenticated endpoints need `Authorization: Bearer <device token>`.

## Accounts and devices

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `POST /v1/register` | — | `{username, invite?, identity_key}` → `{account_id, device_id, token, username}` (ADR-0021). Creates the account and its first device. `username` is `name.NN` (3–20 letters, digits or `_` starting with a letter, a dot, 2–4 digits), stored lowercase: `400` if malformed, `409` if taken. `invite` is required unless the server runs with `CHAT_REGISTRATION=open`: `403` if missing, used or expired. More devices join by link (below) |
| `POST /v1/invites` | ✓ | → `{code, expires_in_days}`: a single-use invite, valid 7 days, shared as `https://<host>/#invite=<code>`. At most 5 unused per account (`429`) |

The operator creates the first invite on the server:
`chat-server create-invite https://chat.example.com`. Invites are stored
as hashes, and deleted when used, so who invited whom is not kept.

The token is 32 random bytes; the server stores only its SHA-256 hash.
Each device's coarse last-seen *day* is recorded on authentication.

### Deleting an account (FR-ID-9)

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `POST /v1/account/delete` | ✓ | `{username}` (typed again) → `204`; `400` if it doesn't match |

Deletes the account and, by cascade:
- its devices and tokens;
- queued envelopes, key packages and claims;
- conversation memberships and link codes;
- reports *about* it.

It also deletes the number's verification codes and request log, and closes
its devices' WebSockets. Rate-limit windows naming its devices expire
within two days. The number can sign up again as a new account. The web
client first sends a leave proposal in every group, so other members'
groups drop it, then erases local storage.

Deleting the reports about an account favours the deleted user's privacy
over moderation history. Revisit if abusers start deleting accounts to
escape reports.

### Attachments (FR-MED-2/3, ADR-0023)

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `PUT /v1/blobs` | ✓ | raw encrypted bytes, `Content-Length` required (≤ 100 MB + 1 MB overhead) → `{blob_id, expires_in_days: 30}` |
| `GET /v1/blobs/{blob_id}` | ✓ | → the bytes, or `404` once expired. A single `Range: bytes=a-b` gives `206` with `Content-Range` (`416` outside the blob) |
| `POST /v1/blobs/uploads` | ✓ | `{size}` → `{upload_id, part_bytes: 8 MiB, parts, expires_in_hours: 24}`. Resumable upload (ADR-0025); the size counts against today's allowance now |
| `PUT /v1/blobs/uploads/{id}/{n}` | ✓ | part `n` (exactly `part_bytes`, the last may be shorter; may be sent again) → `204`. Only the device that started the upload |
| `GET /v1/blobs/uploads/{id}` | ✓ | → `{parts, received: [n, …]}`, to resume |
| `POST /v1/blobs/uploads/{id}/complete` | ✓ | → `{blob_id, expires_in_days: 30}` (same id); `409` while parts are missing |

The server only ever sees ciphertext. The key and hash travel inside the
E2EE message that references the blob (an `Attachment` content body;
format in ADR-0024). Blobs are deleted 30 days after
upload, whether or not they were fetched.

### Backup and restore (ADR-0022)

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `PUT /v1/backup/key` | ✓ | `{auth_hash}` (base64 SHA-256 of the auth secret derived from the recovery key) → `204`. Turns backups on, or switches keys: an older backup is deleted |
| `PUT /v1/backup` | ✓ | raw encrypted bytes, `Content-Length` required (≤ 100 MB), kept in the blob store → `204`; `409` without a key |
| `GET /v1/backup` | ✓ | → the account's backup (raw bytes) or `404` |
| `POST /v1/backup/delete` | ✓ | → `204`: backups off |
| `POST /v1/backup/restore` | — | `{username, auth, identity_key}` → `{account_id, device_id, token, username}`. With the right auth secret: deletes the account's devices, registers this one and tells members' open sessions (`DevicesChanged`). `401` for a wrong username or key alike |

The server never sees the recovery key, the encryption key or anything
readable in a backup. The web client derives keys with HKDF-SHA256 and seals
the backup (gzip, AES-256-GCM). It uploads at most every 10 minutes when
something changed, or on demand.

### Linked devices (ADR-0019)

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `POST /v1/link/start` | — | → `{code}`: 16 random bytes, base64url, valid 10 minutes. The new device shows it as a QR code |
| `POST /v1/link/approve` | ✓ | `{code}` → `204`; the new device will join this account. `404` unknown or expired, `409` already used |
| `POST /v1/link/status` | ✓ | `{code}` → `{device_id}`, `null` until the new device has completed the link. Only the approving account sees it |
| `POST /v1/link/complete` | — | `{code, identity_key}` → `{account_id, device_id, token, username}`, like `register`. `409` until approved; `404` unknown, expired or used. The new device polls this |
| `GET /v1/devices` | ✓ | → `{devices: [{device_id, added_on, last_seen_on, current}]}`: this account's devices (days only), oldest first |
| `POST /v1/devices/remove` | ✓ | `{device_id}` → `204`. Another device of this account: deletes it with its token, queue, key packages and memberships, and closes its WebSocket. `400` for the calling device itself |
| `POST /v1/devices/of` | ✓ | `{account_ids}` (1–200) → `{devices: {account_id: [device_id]}}`: current devices of the given accounts; absent accounts were deleted. Account ids are learned only from groups or a username lookup, which returns devices too. Clients use it to keep every member's devices in their groups (ADR-0022) |

Sends to a removed device are not refused: the server drops it from the
recipients until the account's remaining devices commit its removal from
each group. Welcomes must still go to existing devices.

## Key directory

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `POST /v1/keys` | ✓ | `{key_packages: [b64]}` (1–100, ≤ 4 KiB each, ≤ 200 stored per device, 30-day expiry) → `204` |
| `POST /v1/lookup` | ✓ | `{username}` → `{account_id, device_ids}` or `404`. Exact username only; no search or bulk lookup |
| `POST /v1/groups/epoch` | ✓ | `{group_id}` (b64) → `{epoch, last_commit_hash}` (b64 SHA-256 of the accepted commit's ciphertext) or `404` if no commit was recorded. Lets a client that lost the answer to its commit learn whether it was accepted |
| `POST /v1/keys/claim` | ✓ | `{device_ids}` (1–200) → `{key_packages: {device_id: b64}}`. Each package is handed out once; devices with none left are omitted |
| `GET /v1/keys/count` | ✓ | → `{available}`: this device's unused key packages with more than 3 days left before they expire |

## WebSocket `GET /v1/ws`

Binary Protobuf frames (`proto/chat/v1/envelope.proto`): `ClientFrame` in,
`ServerFrame` out. Replies echo the request's `request_id`; pushed
deliveries have `request_id = 0`.

1. **Authenticate** within 10 s: `Authenticate{token}` → `AuthResult{device_id, key_packages}`.
   `key_packages` is the same count as `GET /v1/keys/count`. The web client
   tops up to 20 whenever fewer than 10 are left: on connect, after joining
   a conversation, and every 6 hours while connected.
   Browsers can't set WebSocket headers and URLs end up in logs, so the
   token travels in the first frame.
2. The server then sends every queued `Deliver{Envelope}` for the device,
   oldest first, and pushes new ones as they arrive.
3. **Ack**`{message_id}` deletes an envelope from the device's queue. No
   reply. Anything unacked is redelivered on the next connection, so
   clients must de-duplicate by `message_id`.
4. **Send**`{envelope, recipient_devices}` → `SendResult{accepted, epoch_conflict}`.
   The server stores one queue entry per recipient device before replying.
   - `HANDSHAKE` envelopes (MLS commits) set `epoch` to the epoch the
     commit was built on. The server accepts exactly one commit per epoch
     per conversation; a loser gets `epoch_conflict = true`, processes the
     winning commit, and retries.
   - `PROPOSAL` envelopes (e.g. a member leaving, ADR-0016) are delivered
     without epoch ordering; another member later commits them.
   - **Authorisation (ADR-0017):** non-welcome envelopes must come from a
     member of the conversation and go to members (`403` otherwise). A
     `WELCOME` may start a new conversation or come from a member, and only
     reaches devices whose key packages the sender claimed in the last 7
     days. Its recipients become members.
   - A commit that adds members sets `welcome` and `welcome_recipients`; the
     server accepts commit and welcome in one transaction.
   - `silent: true` sends no Web Push to offline recipients. The web client
     uses it for delivery and read receipts, which are ordinary encrypted
     MLS messages to the conversation; the server learns only that the
     envelope is silent.
   - Limits: ciphertext ≤ 128 KiB, ids ≤ 64 bytes, ≤ 500 recipients, frame
     ≤ 256 KiB. Attachments go to blob storage (Phase 2), not the socket.
5. **DevicesChanged** (server → client, unsolicited): a member's devices
   changed (restore, link, removal, deletion). The client re-checks its
   groups' devices (ADR-0022).
6. **Ping** → **Pong** at the application level. The server also sends
   WebSocket pings every 30 s to keep proxies from closing idle sockets.

Errors arrive as `Error{code, message}` with HTTP-style codes (400, 401,
429, 500, 503).

The web client re-sends after 429, 500 and 503, backing off from 5 s up to
2 minutes, 8 times. After that the message shows "Not sent: Couldn't reach
the server" with a Retry button. A 400 or 403 fails at once, with the
reason shown under the message. Retry re-encrypts the text for the group as
it is now, under the same message id. A request that gets no answer within
20 s is treated as lost: the client reconnects and re-sends.

## Web Push (FR-NOT-1/2)

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `GET /v1/push/key` | — | → `{public_key}`: VAPID public key (base64url) for `pushManager.subscribe` |
| `POST /v1/push/subscription` | ✓ | `PushSubscription.toJSON()` (`{endpoint, keys: {p256dh, auth}}`, HTTPS endpoint) → `204` |
| `POST /v1/push/unsubscribe` | ✓ | → `204` |

When an envelope is queued for a device with no open WebSocket, the server
sends that device's push service an **empty** push (no payload, VAPID-signed,
TTL 1 day, urgency high), at most once per 30 s per device. The service
worker shows a generic "New message" notification; opening the app connects
and fetches the queue. A `404`/`410` from the push service deletes the
subscription. Configure `CHAT_VAPID_PRIVATE_KEY` (from
`chat-server generate-vapid-key`) and `CHAT_VAPID_SUBJECT`.

## Reports (FR-ID-8)

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `POST /v1/reports` | ✓ | `{account_id, reason: "spam" \| "harassment" \| "other", messages: [{text, sent_at_ms}]}` → `204`. Up to 20 messages of 4000 characters, which the reporter chose to disclose; `404` unknown account |

Reports are kept 90 days for moderation and are the only message content
the server ever sees in readable form, because the reporter sent it. Blocking is
client-side: the blocked person's messages are dropped on the blocker's
devices, and the block list syncs between them in `DeviceSync`.
Verifiable message franking (FR-SAF-1) is not implemented yet.

Message requests (FR-SAF-3) are client-side too: a conversation whose
members include nobody this user looked up or already talks to is listed
under *Message requests* and can be read but not answered until accepted.

## Abuse limits (FR-SAF-2)

Counted in PostgreSQL in fixed windows (table `rate_limits`), so they hold
across restarts and replicas. Exceeding one gives `429` (HTTP) or
`Error{429}` (WebSocket); nothing is counted for a refused request.

| What | Limit | Key |
|------|-------|-----|
| `POST /v1/lookup` | 30 per hour | device |
| `POST /v1/keys/claim` | 300 devices per hour | device |
| Welcomes (first contacts) | 200 recipient devices per day | device |
| Sends over the WebSocket | 600 per minute (token bucket, in memory) | device |
| `POST /v1/register` | 10 per hour | client IP |
| `POST /v1/register` | 1000 per day | whole server |
| `POST /v1/invites` | 10 per day (and 5 unused at once) | account |
| `POST /v1/link/start` | 20 per hour | client IP |
| `POST /v1/reports` | 20 per day | device |
| `POST /v1/devices/of` | 120 per hour | device |
| `POST /v1/backup/restore` | 10 per hour; 10 per day | client IP; account |
| `PUT /v1/blobs` | 2048 MB per day | device |

The client IP is the socket peer, or the last `X-Forwarded-For` entry when
`CHAT_TRUST_PROXY_HEADERS=true` (Helm `server.trustProxyHeaders`, on by
default behind the ingress). Each limit can be changed with
`CHAT_LIMIT_<NAME>`, e.g. `CHAT_LIMIT_CODES_PER_IP_PER_HOUR` (see
`crates/chat-server/src/config.rs`). The web client keeps a rate-limited message
queued and re-sends it after 5 s, doubling to 2 minutes.

## Calls (ADR-0028)

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `GET /v1/turn` | ✓ | → `{ice_servers: [{urls, username?, credential?}], ttl}`: STUN servers (`CHAT_STUN_URLS`), and TURN servers (`CHAT_TURN_URLS`) with coturn REST-API credentials valid for `ttl` seconds when `CHAT_TURN_SECRET` is set |

| `POST /v1/calls/join` | ✓ | `{conversation_id, call_id}` (base64; call id 16 bytes) → `{url, token}`: a LiveKit room token for a group call (ADR-0031), members of the conversation only (`403` otherwise, `404` when group calls are off) |
| `POST /v1/calls/status` | ✓ | same body → `{participants}`: how many are in that call now (`0` once it ended) |

Offers, answers, candidates and hang-ups are end-to-end encrypted messages
(`Call` content); the server only relays them.

## Retention

An hourly job deletes queue entries older than 30 days (FR-MSG-9), expired
key packages and codes, code-request logs older than a day and rate-limit
windows older than two days, and reports older than 90 days.

## Not yet implemented

- Sealed sender: the server stores which devices belong to which
  conversation (ADR-0017).
- Multi-replica fan-out (PostgreSQL LISTEN/NOTIFY or Valkey pub/sub).

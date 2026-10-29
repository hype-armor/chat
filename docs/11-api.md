# 11 — Server API (v1)

**Status:** Implemented in `crates/chat-server` (Phase 1, in progress).

REST endpoints take and return JSON. Binary values (keys, key packages) are
standard base64. Errors are `{"error": "<message>"}` with an HTTP status.
Authenticated endpoints need `Authorization: Bearer <device token>`.

## Accounts and devices

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `POST /v1/auth/request-code` | — | `{phone}` (E.164) → `204`. Sends a 6-digit code (10-minute expiry). Limits: 3 per 15 min and 10 per day per number → `429` |
| `POST /v1/auth/verify` | — | `{phone, code, identity_key}` → `{account_id, device_id, token}`. Creates the account on first use; each call registers a **new device** (max 10). 5 wrong attempts invalidate the code |

The token is 32 random bytes; the server stores only its SHA-256 hash.
Each device's coarse last-seen *day* is recorded on authentication.

## Key directory

| Method & path | Auth | Body → Response |
|---------------|------|-----------------|
| `POST /v1/keys` | ✓ | `{key_packages: [b64]}` (1–100, ≤ 4 KiB each, ≤ 200 stored per device, 30-day expiry) → `204` |
| `POST /v1/lookup` | ✓ | `{phone}` → `{account_id, device_ids}` or `404`. One number per call; no bulk lookup |
| `POST /v1/groups/epoch` | ✓ | `{group_id}` (b64) → `{epoch, last_commit_hash}` (b64 SHA-256 of the accepted commit's ciphertext) or `404` if no commit was recorded. Lets a client that lost the answer to its commit learn whether it was accepted |
| `POST /v1/keys/claim` | ✓ | `{device_ids}` (1–200) → `{key_packages: {device_id: b64}}`. Each package is handed out once; devices with none left are omitted |

## WebSocket `GET /v1/ws`

Binary Protobuf frames (`proto/chat/v1/envelope.proto`): `ClientFrame` in,
`ServerFrame` out. Replies echo the request's `request_id`; pushed
deliveries have `request_id = 0`.

1. **Authenticate** within 10 s: `Authenticate{token}` → `AuthResult{device_id}`.
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
   - Limits: ciphertext ≤ 128 KiB, ids ≤ 64 bytes, ≤ 500 recipients, frame
     ≤ 256 KiB. Attachments go to blob storage (Phase 2), not the socket.
5. **Ping** → **Pong** at the application level. The server also sends
   WebSocket pings every 30 s to keep proxies from closing idle sockets.

Errors arrive as `Error{code, message}` with HTTP-style codes (400, 401,
429, 500, 503).

## Retention

An hourly job deletes queue entries older than 30 days (FR-MSG-9), expired
key packages and codes, and code-request logs older than a day.

## Not yet implemented

- Web Push wake-ups for offline devices (FR-NOT-*).
- Sealed sender and send authorisation: any authenticated device can
  currently send to any device id.
- Per-device rate limits on lookup/claim (Valkey), device removal, account
  deletion, a real SMS provider.
- Multi-replica fan-out (PostgreSQL LISTEN/NOTIFY or Valkey pub/sub).

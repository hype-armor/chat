# Server management

Storage quotas and account message limits use PostgreSQL, so all replicas share
the same policy. The server continues to store ciphertext only.
See [ADR-0040](adr/0040-server-storage-and-account-limits.md).

## Operator access

`chat-admin` is a local command, not a public administrator endpoint. Use trusted
operator database credentials in `DATABASE_URL`. Never give these credentials to
chat users, place them in browser configuration, or include them in screenshots.
Run `chat-admin migrate` before using policy commands. This updates the database
schema; take a database backup and stop old writers first during an upgrade.

The server image includes `/usr/local/bin/chat-admin`. For a local checkout:

```sh
cargo build -p chat-server --bins
export DATABASE_URL='postgres://operator:password@localhost/chat'
./target/debug/chat-admin --help
```

For Docker Compose, run the command in the existing server container with
`docker compose exec SERVER_SERVICE /usr/local/bin/chat-admin ...`.
For Kubernetes, use `kubectl exec SERVER_POD -- /usr/local/bin/chat-admin ...`.
Substitute your service or pod name. Neither command needs a public management port.
The process uses the container's `DATABASE_URL`; restrict access to this credential
and to container execution.

## Storage quotas

Set a server-wide ciphertext object-store cap and a default account cap:

```sh
# 100 GiB across the server; 2 GiB for each account by default.
chat-admin storage server 107374182400
chat-admin storage default 2147483648

# Give one account 5 GiB.
chat-admin storage account ACCOUNT_UUID 5368709120

# Remove the individual override, or explicitly allow unlimited storage.
chat-admin storage account ACCOUNT_UUID inherit
chat-admin storage account ACCOUNT_UUID unlimited
```

Values are integer **bytes**, not megabytes. Zero blocks new allocations.
`unlimited` removes that particular cap; the other cap still applies. An account
with unlimited storage cannot exceed the server-wide cap. `inherit` removes an
account override so future changes to the default also apply to that account.
The server-wide cap starts unlimited. Set it before accepting public traffic.
The initial default account cap is 2 GiB.

**Upgrade note:** `CHAT_LIMIT_BLOB_MB_PER_ACCOUNT` is obsolete. The new server
rejects this variable instead of silently ignoring your former cap. During the
upgrade maintenance window, run `chat-admin migrate`, set the equivalent byte limit
with `chat-admin storage default BYTES`, then remove the variable before starting
the new server. For example, a former value of `100` becomes `104857600` bytes.

Quotas cover encrypted attachments, encrypted backups, and the full size of
unfinished uploads. Replacement backups temporarily count both versions until
the old object is deleted. Multipart completion does not charge the bytes twice.
Expired objects remain charged until deletion succeeds. Quota reductions never
delete existing data. Downloads, cleanup, and account deletion remain available.

These are **not physical disk quotas**. Leave room for object-store overhead,
PostgreSQL data and WAL, map tiles, logs, infrastructure backups, and other services.
The existing queue row cap and daily send/upload budgets remain separate controls.

Inspect charged usage and policies:

```sh
chat-admin usage
chat-admin usage ACCOUNT_UUID
```

The JSON output reports charged bytes and the number of tracked object keys or
reservations. An account query includes its storage and message overrides.
`inherit` in this output means the configured default applies.
The command uses account UUIDs, not message contents or contact lists.

## Message rate limits

The default account limit is 600 accepted send requests per minute. Set the
service default through the server environment and restart the server replicas:

```sh
CHAT_LIMIT_SENDS_PER_ACCOUNT_PER_MINUTE=120
```

Every linked device and server replica shares this account counter. A request
containing a commit and its welcome consumes 1 unit. All envelope types share
the budget, including encrypted call and typing messages. Invalid or unauthorized
requests do not consume the account counter. Transactions roll back the charge
when a send fails later.

Set an individual account override without restarting:

```sh
chat-admin messages account ACCOUNT_UUID 30
chat-admin messages account ACCOUNT_UUID 0       # Block new sends.
chat-admin messages account ACCOUNT_UUID inherit
```

Changes apply to subsequent requests. Already accepted work is not revoked.
Keep `CHAT_LIMIT_SENDS_PER_MINUTE` as the separate per-device token bucket.
The existing daily ciphertext allowance, first-contact, signup, lookup, invite,
report, TURN, and download limits remain in place. Backup uploads additionally
have a shared account budget of 288 attempts per day and the configured
`CHAT_LIMIT_BLOB_MB_PER_DAY` ciphertext allowance. Failed attempts still consume
these abuse budgets, even when confirmed abort cleanup releases their storage.
Negative limit configuration
fails startup instead of silently disabling protection.

HTTP refusals use `429`; WebSocket refusals use `Error{429}`. The client retains
outgoing messages and retries with backoff. These limits do not inspect plaintext.

## User quota view

Account settings show stored ciphertext, reserved upload space, and the effective
account quota. Users can refresh the view and see near-limit and over-limit notices.
Unlimited quotas appear explicitly. Loading failures appear as errors, not zero usage.
The core worker fetches `GET /v1/storage`; the UI does not receive credentials.
Users cannot inspect server totals or other users' usage through this endpoint.

## Interrupted writes and upgrades

Reservations survive crashes and conservatively retain capacity. Never remove a
reservation just because it is old: a slow writer might still publish its object.
The system does not yet provide an automated orphan reconciliation command.

If usage appears too high, inspect the object store and database with operator
tools. Stop or fence all upload writers before any manual reconciliation. Confirm
that an object is deleted or absent before removing its ledger charge. Keep a
backup of the ledger before maintenance. Do not clear the ledger to make room;
that would let stored bytes bypass the quota.

The migration backfills known attachments, multipart sessions, and backups,
including expired rows. Objects orphaned before this migration need a separate
object-store inventory: database migrations cannot discover unknown objects.
Deploy the migration with all old server writers stopped. Old binaries do not
reserve storage and must not run alongside the new quota-enforcing server.

Account deletion preserves global charges for objects that still exist and drops
the ledger's account association. Such objects can need operator cleanup if their
normal cleanup references no longer exist. Do not treat account deletion as proof
that physical bytes were freed.

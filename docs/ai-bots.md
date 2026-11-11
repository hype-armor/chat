# Opt-in AI bots

The bot system combines the [synthetic social world](bot-social-world.md), a
native MLS client worker (`crates/chat-bot`), and a Node.js coordinator
(`scripts/bot-world/run.mjs`). It is separate from the web client and chat server.

**Do not enable it on a live service before isolated-service validation.** No
accounts or messages are created by the default `plan` command. No provider API
key or state key is included in this repository.

## Free model selection

Default: **OpenRouter `openrouter/free`**, which routes only to free models.
Optionally set `CHAT_BOT_AI_MODEL` to a catalog model ID ending in `:free`.
Availability can change; select an actual free catalog entry, not a paid model
with an invented suffix. Different bots share one model but have distinct
personas and context. Router-selected model families can vary between requests.

The adapter uses only `https://openrouter.ai/api/v1/chat/completions`. It rejects
redirects and paid-model configuration, sets a short output cap, and has no
fallback arrays, tools, plugins, search, or automatic paid retries. It requests
`provider.data_collection: "deny"`; an incompatible provider can refuse the
request. This setting is **not** a promise of zero retention or zero training.
Read the provider terms before activation.

Official references checked on 2026-11-11:

- [Free variants and paid fallback warning](https://openrouter.ai/docs/guides/routing/model-variants/free.md)
- [Free router](https://openrouter.ai/docs/guides/routing/routers/free-router.md)
- [Rate limits](https://openrouter.ai/docs/api/reference/limits.md)
- [Provider data collection](https://openrouter.ai/docs/guides/routing/provider-selection.md)

Published limits are 20 requests/minute and 50/day below the prior-credit-purchase
tier. A higher tier has different limits. The default coordinator budget is
**50 attempts/day total across all 100 bots**, not per bot, and 10/minute with
one inference in flight. It does not buy credits or change the account tier.
Free availability does not mean free hosting or guaranteed service.

The scheduler shares inference opportunities across direct chats, trios,
10-member rooms, 50-member rooms, and other sizes. Within each size it selects
the oldest eligible room. The 190 direct chats cannot consume the initial budget
before groups speak. Personality weights, activity hours, turn caps, and quiet
periods still apply; it does not make every group member respond.

## Human opt-in

Use the app's existing exact-username contact lookup to start a conversation
with a bot or explicitly add it to a group. Default usernames are `ai_bot.0001`
through `ai_bot.0100`; a custom prefix must include `bot` explicitly. Profiles
contain `(AI bot)`.

1. A bot sends a disclosure naming OpenRouter and the configured model/router.
2. **Every current human account** sends the exact `/ai consent <nonce>` command
   shown in that room. Linked devices belong to the same account.
3. Only text received after unanimous consent enters AI context. Text received
   while another member had not consented is not retained for inference. This
   boundary uses bot receipt order, not an unverifiable sender clock; a delayed
   message can arrive after consent even if someone sent it earlier.
4. `/ai stop` pauses the room, clears local prompt history and consent, and
   cancels pending inference work. It cannot recall text already submitted.
5. `/ai start` requests a new consent round. It does not restore old consent or
   history. Membership/device changes and provider disclosure changes also
   require fresh consent.

The nonce binds consent to the room's current membership and disclosure. A bot
cannot consent for a human. Profiles, display names, claimed sender fields in
message text, friendship edges, and friends-of-friends do not establish consent.
Human context stays in that conversation; the coordinator never retrieves
history from other rooms. It does not send attachments, location, live location,
calls, receipts, or typing events to the model.

E2EE still applies between clients and the server. A bot is a participant that
can read messages it receives. The operator controls that client and can read
received messages, including before external-inference consent. Consent gates
submission to the external provider, not the bot's ability to decrypt messages.
Users who do not want this must not add bots or consent; any human member can
stop inference. Do not silently add bots to existing private conversations.

## Local checks (no credentials or external AI calls)

Requires Node.js 22+ and Linux `flock` (normally from `util-linux`). Rust uses the
repository toolchain. Node's and Rust's AES-GCM libraries encrypt state; the
coordinator requires a private state directory and an exclusive OS-managed lock.

```sh
node scripts/bot-world/run.mjs plan
node --test scripts/bot-world/*.test.mjs
CARGO_BUILD_JOBS=1 cargo test -p chat-bot
CARGO_BUILD_JOBS=1 cargo clippy -p chat-bot --all-targets -- -D warnings
```

The `plan` command has no network or state writes. Unit tests use mock inference,
not a live AI account. Full service tests must use isolated databases and server
ports. Fixture/protocol tests do not substitute for real-server rollout checks.

The CI Rust job also builds `chat-server` and `chat-bot` and runs
`scripts/bot-world/integration.mjs` with mocked inference. That check starts its
own server on an ephemeral loopback port. To run it manually, supply
`BOT_TEST_DATABASE_URL` for a dedicated loopback PostgreSQL database whose name
starts with `chat_bots_test`. The script refuses other database names, remote
hosts, and URL overrides before any network activity. It never uses an AI API key.

## Operator setup

Build the native worker:

```sh
CARGO_BUILD_JOBS=1 cargo build --release -p chat-bot
```

Create a **separate** provider API key. Never reuse agent, application-user, or
other service credentials. Generate a random state key without printing it in
public logs or chat. Keep secrets in a private environment file, mode `0600`,
owned by the service operator. A sample with placeholders follows:

```ini
CHAT_BOTS_ENABLED=true
CHAT_BOT_SERVER=https://chat.example.com
CHAT_BOT_BINARY=/opt/chat/bin/chat-bot
CHAT_BOT_STATE_DIR=/var/lib/chat-bots
CHAT_BOT_STATE_KEY=<base64-encoded-32-random-bytes>
CHAT_BOT_AI_API_KEY=<separate-openrouter-key>
CHAT_BOT_AI_MODEL=openrouter/free
CHAT_BOT_DAILY_REQUESTS=50
CHAT_BOT_REQUESTS_PER_MINUTE=10
CHAT_BOT_USERNAME_PREFIX=ai_bot
```

HTTPS is mandatory except loopback HTTP for isolated local services. Store the
state key outside the state directory and protect backups of both separately.
Losing the key loses access to those bot identities. Authentication failure does
not erase credentials or register replacement identities automatically.

`CHAT_BOT_STATE_DIR` holds separate `controller/` and `transport/` directories.
Both contain encrypted state, not plaintext snapshots or prompt logs. Use local
storage with atomic rename, `fsync`, and `flock`; network shares are unsupported.
Do not share a state directory across servers or different worlds. The controller binds
its state to the server URL and complete world configuration. A changed model
invalidates consent but retains request usage.

### Bootstrap explicitly, then run

For an invite-only server, supply `CHAT_BOT_INVITES_FILE` pointing to a private
JSON map of bot fixture IDs to unused invite codes:

```json
{"bot-001": "<invite-for-first-bot>", "bot-002": "<invite-for-second-bot>"}
```

Do not commit this file. Bootstrap uses supported registration, key-claim, and
MLS welcome flows, not direct database memberships. It saves progress and can
resume with the same identities and fixture-to-conversation mappings.

```sh
# Use 2 accounts first against an isolated server.
CHAT_BOT_BOOTSTRAP_LIMIT=2 node scripts/bot-world/run.mjs bootstrap
node scripts/bot-world/run.mjs run
```

Later increase the bootstrap limit to 100. Existing server limits still apply:
the default IP registration limit is 10/hour, and key claims and welcomes also
have limits. Expect staged bootstrap, not instant creation of 100 accounts. A
rate limit stops bootstrap safely; rerun after the window resets. Do not bypass
limits or test registrations on a live deployment.

The runner chooses active bots with room-specific reply weights, avoids
immediate self-replies, waits between replies, and limits consecutive autonomous
turns. Bot-only fixture rooms can start conversations; unknown human rooms wait
for consent and post-consent text. Quiet members need not answer every message.
Provider failures back off globally; failed, timed-out, and cancelled inference
attempts still count against the local durable budget. The daily quota resets
only when the UTC date advances, not when a clock moves backwards.

### Service management

`deploy/systemd/chat-bots.service` is an optional, disabled-by-installation
service definition. Install the repository tools under `/opt/chat`, the worker at
`/opt/chat/bin/chat-bot`, and secrets at `/etc/chat/bots.env`. Create the
`chat-bots` user/group. Bootstrap with that same user, environment, and state path
before starting the service. Do not run duplicate coordinators.

Stop the service for an operator-wide kill switch. `CHAT_BOTS_ENABLED` must be
exactly `true` for network operations. Graceful shutdown cancels inference, saves
state, and closes the private worker pipe. OS locks release after a crash;
never delete encrypted state to solve an authentication or locking error.

## Architecture and boundaries

- Native worker: authenticated server transport, real MLS clients, encrypted
  snapshots, ciphertext retry work, current membership, event replay/ack.
- Coordinator: account/fixture mapping, explicit consent, bounded room context,
  scheduled speaker selection, persisted quota reservations, and free inference.
- Provider adapter: fixed endpoint, free-only model guard, bounds, cancellation,
  safe errors, and scoped persona prompts. Model instructions are not access
  controls; consent/context filtering happens before the request.

The coordinator observes incoming revocations before its serialized persistence
queue. It checks cancellation again after membership and disk I/O. The worker
must fence send issuance against changed MLS membership and unacknowledged room
events. The boundary is what the bot has received before a request/send is
issued, not when a human first tapped Send on another device.

### Conservative lifecycle limits

An unreconciled device change or MLS proposal durably blocks the affected rooms.
The worker refuses both membership authorization for inference and message sends
until an authenticated MLS commit reconciles the room. It does not implement a
full replacement for the web worker's device reconciliation. Keep the runner
stopped when reconciliation cannot complete; do not delete state to force it.
Device-change notices also clear the coordinator's affected consent and context.
The notification has no changed-peer identifier, so this can block every room
of a notified bot, including bot-only rooms, until those rooms receive a commit.

The worker waits for an application-Ping barrier after authentication. The server
sends queued deliveries before that Pong. Old queued application sends cannot
race ahead of reconnect revocations. The coordinator must explicitly revalidate
and retry generated work; reconnect never autonomously replays AI replies.

State is bounded: at most 256 unacknowledged events, 4,096 native outbox records,
and 65,536 receive-deduplication records per bot. Reaching a cap stops the worker
rather than dropping a revocation or overwriting state. This version has no
automated journal compaction or rollover command. Plan maintenance before the
journal fills, and preserve the encrypted state for recovery.

No plaintext keys, tokens, message content, provider responses, or prompts should
appear in logs. The service prints aggregate startup/bootstrap progress only.
No bot state enters user backup/sync or the chat server database as plaintext.

See [ADR-0044](adr/0044-opt-in-ai-bot-runner.md) for the accepted design.

# ADR-0044: Run disclosed AI bots as native encrypted clients

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** Greg
- **Related requirements:** Owner request to build the remaining bot system; ADR-0002, ADR-0017, ADR-0043

## Context

The owner approved live, opt-in AI bots, a free hosted API, and 100 synthetic
profiles. The offline world exists. The chat server must remain a ciphertext
relay. Inference must not expose a human conversation without explicit consent.

## Options considered

1. **Native encrypted client worker plus an operator-run coordinator.** Reuses
   `chat-core` without adding AI origins, keys, or inference to the web client.
2. **AI processing inside the chat server.** Incompatible with the server's
   ciphertext-only role.
3. **Local inference only.** Offers better control over plaintext, but the
   owner selected a free hosted API rather than local hardware.

## Decision

Use a native Rust worker for registration, MLS, authenticated membership,
WebSockets, durable ciphertext sends, and encrypted client snapshots. Use a
Node.js coordinator for personalities, room-scoped context, consent, scheduling,
and external inference. Communicate only over private child-process stdio.

Use OpenRouter's `openrouter/free` router by default. Permit explicitly named
`:free` model variants, but never configure paid fallback arrays, tools, plugins,
or web search. Request `provider.data_collection: deny`. This is not a guarantee
of zero retention, zero training, model quality, or continuous free availability.

Bots identify themselves as fictional AI participants. They send a provider and
model disclosure before inference with humans. Every current human account must
send the exact room-specific consent command. Any authenticated human member can
stop AI processing. New membership or disclosure changes invalidate prior consent
and discard local prompt history. Only text received after unanimous consent can
enter the context; media, locations, calls, receipts, and typing cannot. Receipt
order defines this boundary, not a sender clock; delayed text can arrive after consent.

Use current authenticated MLS identities, not profile labels, to identify humans
and managed bots. A social edge or shared room never grants history access.

Persist a global request reservation before each provider attempt. Failed and
cancelled attempts still count. Default to 50 attempts per UTC day, 10 per minute,
1 in-flight inference, short replies, bounded room histories, and limited
consecutive bot turns. Back off on unavailable or rate-limited providers.

Encrypt snapshots, tokens, consent, context, quotas, and retry work at rest with
standard AES-256-GCM libraries. Keep the 32-byte state key outside the state
directory. Use exclusive process locks and durable atomic replacement. Preserve
state on authentication failure; never register replacement identities silently.

## Consequences

No new plaintext server metadata or external web-client origin is necessary.
Human opt-in works through ordinary authenticated encrypted chat commands, not a
server-side consent flag. The bot operator controls a participant client and
can read messages that client receives, even before external-inference consent.
The selected inference providers receive only post-consent context. E2EE protects
delivery; it does not prevent a participant from submitting received text to a provider.

A processed stop invalidates pending coordinator work. Membership checks and
pending-event fences protect native send issuance. A stop cannot recall an
inference request or message already submitted before the stop reaches the bot.
Prompt rules are not a security boundary; deterministic context selection and
consent gates must enforce data access before any provider request.

Free-tier quotas are shared by all bots, not multiplied by the number of bot
accounts. At the published 50-request daily tier, the world operates slowly.
Actual live activation requires separately supplied secrets and operator setup;
this code change does not deploy bots or alter registration or storage limits.

## Validation

Use mock provider tests, deterministic coordinator and consent-race tests,
encrypted-state restart tests, native MLS tests for 2/3/10/50-member rooms, and
isolated server integration tests. Do not run tests against the live deployment.
Document checks that the current environment cannot run.

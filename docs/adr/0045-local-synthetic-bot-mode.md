# ADR-0045: Default to local synthetic bot text for the first pass

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** Greg; implementation by Pi
- **Related:** ADR-0043, ADR-0044

## Context

The first pass needs visible encrypted chat traffic at conversation-like intervals,
not AI-generated dialogue. Hosted inference adds credentials, privacy boundaries,
availability limits, and a 50-request shared daily budget without helping this goal.
The existing native worker already implements accounts, groups, and encrypted delivery.

## Options considered

1. Continue with hosted inference for all traffic. This creates more realistic text
   but limits volume and needs a provider account.
2. Generate random sentences locally and reuse the encrypted runner. This provides
   inexpensive fixture traffic without processing human content for generation.
3. Insert plaintext fixture messages directly in the server. This bypasses MLS and
   does not validate the actual message path. Reject this option.

## Decision

Default the CLI to `CHAT_BOT_MODE=synthetic`. Keep hosted inference available only
with explicit `CHAT_BOT_MODE=ai`. Synthetic generation receives only a cancellation
signal, not prompts, personas, or human history. Every generated message starts
with `[Synthetic]`. The coordinator stores scheduling metadata rather than text history.

Reuse authenticated membership checks, durable retry work, and room opt-in. Support
`/bots consent <nonce>`, `/bots stop`, and `/bots start`, with existing `/ai` commands
as aliases in synthetic mode. Changing modes clears room consent, pending work, and
context. Preserve the separate AI request quota across mode changes.

Use random 5–30-second reply gaps, 3–6-message bursts, and 5–60-minute quiet periods.
Preserve personality schedules and speaker weights. A human-created room needs an
opted-in ordinary message before the first burst; subsequent bursts can follow quiet
periods until stopped. A shared persisted traffic budget defaults to 12 send attempts
per minute, including retries, with global spacing. Configuration permits 1–120.
Clock rollback must not replenish the budget. Server limits remain authoritative.

## Consequences

The first pass needs no model account, provider key, or external inference. It does
not simulate meaningful replies to human text. The operator still controls recipient
clients, and the encrypted native event journal can transiently contain received text.
There is no new observer backdoor: people watch through ordinary groups they own.
Existing native journal capacity and reconciliation limitations remain in effect.

## Validation

Use deterministic fake-clock tests for spacing, bursts, quiet periods, stop/start,
mode changes, retries, and clock rollback. Prove that private text does not enter
synthetic history or generator arguments. Extend isolated real-server integration
coverage to generate local text, deliver it through MLS, decrypt it, and stop it.
Run this integration in CI without recreating large build caches on the work server.

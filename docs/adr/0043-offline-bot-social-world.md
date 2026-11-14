# ADR-0043: Build the synthetic bot social world before live integration

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** Greg
- **Related requirements:** Owner-approved bot social-world plan; ADR-0002, ADR-0017

## Context

The owner wants 100 opt-in AI bots with a sparse social network and overlapping
conversations of 2, 3, 10, and 50 members. The owner requested the social world
first, before choosing a model or implementing the live bot runner.

A social fixture must not bypass MLS membership, create live accounts, or imply
that a friend-of-a-friend relationship grants access to private conversations.

## Options considered

1. **Provider-independent offline fixture and deterministic generator.** Makes
   the social structure reviewable and testable without credentials or traffic.
2. **Create live bots and conversations immediately.** Demonstrates activity
   sooner, but couples the social design to provider, consent, and runtime work.

## Decision

Build option 1 with Node.js standard-library tools, a versioned JSON format,
a checked-in 100-bot sample, validation, and a restricted configuration projection.
Keep this tooling outside the server and web client runtime.

Represent social relationships separately from group co-membership. Give each
room its own fictional shared setup. Do not generate private chat histories.

The accepted scope covers only the offline world. It does not approve a model
provider, external disclosure of messages, live account creation, or deployment.

## Consequences

The social world can evolve without AI inference costs or production writes.
Fixture IDs are not live identifiers. A future runner must create actual MLS
conversations through supported clients and verify current membership and consent.

Configuration projections help test scoping, but cannot enforce live privacy.
The operator can inspect all synthetic data. Real history isolation requires
separate runtime design, tests, and review.

## Validation

Use deterministic generation, JSON round-trip checks, and focused Node.js tests.
Check graph connectivity, sparse relationships, overlapping groups, exact member
counts, malformed memberships, and conversation-specific configuration views.

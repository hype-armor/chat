# ADR-0009: No federation in v1; self-hosting supported

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** NFR-OPS-4

## Context
Fully open code invites self-hosting; federation adds identity, spam and protocol-versioning complexity.

## Options considered
1. **Self-hosting only**: each server is its own island.
2. **Federation in v1**: much larger scope.

## Decision
v1 supports independent self-hosted deployments. Federation is reconsidered after launch (possibly via MIMI, the IETF's More Instant Messaging Interoperability work).

## Consequences
Users on different servers can't talk to each other in v1, but offline local mode works across servers because it needs no server.

## Validation
Revisit after launch.

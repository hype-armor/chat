# ADR-0012: Licence: AGPL-3.0-or-later (code), CC BY 4.0 (spec)

- **Status:** Proposed
- **Date:** 2026-10-28
- **Related requirements:** NFR-SEC-8

## Context
The project is fully open. We want modifications to hosted servers to remain open.

## Options considered
1. **AGPL-3.0**: modifications offered as a network service must be shared; compatible with libsignal if ever needed.
2. **Apache-2.0 / MIT**: maximum adoption, but allows closed forks of the service.
3. **Split**: AGPL for server/app, Apache-2.0 for the core library to encourage third-party clients.

## Decision
Proposed: AGPL-3.0-or-later for server and client, CC BY 4.0 for the protocol spec. Needs a stakeholder decision; the split option is a reasonable alternative.

## Consequences
Some companies won't use AGPL code.

## Validation
Stakeholder sign-off.

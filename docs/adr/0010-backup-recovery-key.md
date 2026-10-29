# ADR-0010: Encrypted backup with user-held recovery key

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** FR-MSG-13

## Context
Browsers may evict storage. Losing keys means losing history and identity continuity.

## Options considered
1. **No backup**: unacceptable for web.
2. **Recovery key (user-held)**: no trusted hardware needed.
3. **PIN + server-side enclave**: needs SGX-class hardware that self-hosters won't have.

## Decision
Optional (strongly encouraged) encrypted backup: a 128-bit recovery key shown once as words; the backup blob is stored on the server.

## Consequences
Losing the recovery key means the backup can't be restored, by design.

## Validation
Restore test in CI using Playwright with a wiped browser profile.

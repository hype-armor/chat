# ADR-0032: Opt-in, anonymous daily call statistics

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** project owner, Claude
- **Related requirements:** Phase 3 exit criterion (call success ≥ 99 %), NFR-OPS-1
- **Builds on:** ADR-0028, ADR-0031

## Context
Phase 3 ends when calls succeed at least 99 % of the time. Only clients
know whether a call connected: the server relays encrypted signalling it
can't read, and LiveKit and coturn see only part of the picture. Reporting
each call as it happens would tell the server who calls and when, which
the ground rules forbid ("no extra metadata on the server").

## Decision
1. **Opt-in** ("Share anonymous call statistics" in Privacy, off by
   default; turning it off forgets what was counted).
2. **Counted on the device, sent once a day as totals**: per kind (1:1,
   group) the calls that connected and failed, and up to 100 setup times
   rounded to 0.1 s. Only calls that were answered count; failed means
   answered but no media, or dropped. No call ids, times, peers or
   conversations.
3. **Unauthenticated** `POST /v1/stats/calls`, so a report can't be tied
   to an account; per-IP rate limit (6 a day) through the usual limits
   table; implausible totals refused.
4. **Kept only as Prometheus counters** (`chat_calls_total{kind,outcome}`,
   `chat_call_setup_seconds{kind}`) on the metrics port; not logged or
   stored.

## Consequences
- The success rate covers opted-in devices only; good enough to steer by,
  not a census. Server-side signals (LiveKit room stats, coturn
  allocations) complement it.
- The server learns that some device at an IP address made calls on some
  day; the per-IP rate-limit key lives as long as other rate limits (two
  days).
- Reporting is best effort: a device that never comes online again never
  reports.

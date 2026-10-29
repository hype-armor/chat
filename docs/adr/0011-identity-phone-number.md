# ADR-0011: Account identity: phone number

- **Status:** Superseded by ADR-0021 (usernames and invites)
- **Date:** 2026-10-28
- **Related requirements:** FR-ID-1, NFR-LEG-5

## Context
Stakeholders chose phone numbers as the account identifier.

## Options considered
1. **SMS one-time code** with a voice-call fallback through a pluggable provider interface (Twilio Verify, Vonage, MessageBird...).

## Decision
Phone number + one-time code. Contact lookup is one number at a time and rate-limited (hashing doesn't hide phone numbers). Phone numbers are never exposed in offline/stranger contexts. Self-hosters configure their own provider; a dev mode logs codes.

## Consequences
SMS costs and SMS-pumping fraud must be controlled. The server knows each user's phone number (a metadata cost).

## Validation
Abuse simulations of the registration flow before launch.

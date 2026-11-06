# ADR-0037: Until-stopped live location uses renewable leases

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** Project owner, Pi
- **Related requirements:** FR-LOC-2, FR-LOC-3, FR-LOC-6
- **Extends:** ADR-0027

## Context

The current live-location sessions end after 15 minutes, 1 hour or 8 hours. The owner requested an option that continues until the sender stops it. The web app cannot send location updates while it is closed or in the background. The clients also need to remove stale coordinates if the sender cannot send a stop message.

MLS messages cannot be dropped or coalesced by the server. Every update must remain an ordinary encrypted message so that message ratchets stay in order.

## Options considered

1. **No expiry.** Keep each session open until a stop arrives. This can leave an old point on recipients' devices forever if the sender closes the app, loses the device or cannot send a stop.
2. **Renewable 8-hour lease.** Each location update extends the session expiry to 8 hours after that update. A recipient removes the point after 8 hours without an update. This bounds stale-point retention and keeps the existing expiry validation.

## Decision

Use option 2. Add an `until_stopped` field to the encrypted live-location content. For this mode, each update sets `expires_at_ms` to 8 hours after its send time. A new update renews the lease. A stop message ends the session at once.

The sender stores the session locally across reloads. The web client resumes it when the app opens and obtains a location fix. Resuming keeps the original session id and card, even after its lease expired. A later unexpired update can reopen a locally expired card. An explicit stop stays final. Each share posts only 1 card.

The contact details view shows active live-location cards above safety-number verification. Clicking the contact name or photo opens this view. The cards update in place and disappear when sharing stops or expires.

The UI keeps sharing opt-in and per conversation. It shows a persistent Stop control. It says that sharing pauses when the app is closed or in the background. Recipients see the last update time and the 8-hour inactivity limit. No background location permission is available in the web app.

## Consequences

- An until-stopped share can continue while the app stays open. It has no fixed duration.
- Recipients keep the last point for at most 8 hours after the last update.
- Each location update is a normal MLS message. The server cannot read or coalesce it.
- Long shares can produce unbounded messages over time. The existing update cadence and server limits still apply.
- Older clients ignore `until_stopped` and show the session only until its first 8-hour lease expires.

## Validation

- Unit tests must verify that until-stopped updates renew the lease and timed sessions keep their original expiry.
- Unit tests must verify that a resumed share keeps its original card and session id on both devices.
- Browser tests must start an until-stopped share, receive updates, and end the share with Stop.
- Browser tests must show the live card above verification when the user clicks the contact name or photo.
- Check the visible indicator and the 8-hour inactivity notice.

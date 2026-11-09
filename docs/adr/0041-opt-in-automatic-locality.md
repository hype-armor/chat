# ADR-0041: Opt-in automatic approximate locality

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Project owner, implementation agents
- **Related requirements:** FR-LOC-4, issue #132
- **Builds on:** ADR-0002, ADR-0019, ADR-0026, ADR-0034

## Context

Issue #132 requests a city and state beside the recipient name.
The owner selected automatic current location rather than a manual profile field.
Profiles have no existing city or state source.
Coordinates and free-text location labels do not establish municipal membership.
The page must not call an external geocoder or silently enable location collection.

## Options considered

1. Use recipient location messages. Old messages can be stale and contain no structured locality.
2. Query an external geocoder. This discloses coordinates and introduces a new trusted service.
3. Read vector map labels. Current place features do not reliably provide administrative regions.
4. Bundle a licensed gazetteer. This works offline but describes nearby places, not administrative boundaries.

## Decision

Use option 4 with explicit, device-local consent and an approximate label.
The privacy settings checkbox is named **Automatic current location**.
It defaults to off and explains recipients, foreground operation, expiry, and limitations before permission access.
The browser and operating system continue to control permission grants.
The app must not store a fake permission grant.

The page obtains fixes because browsers do not expose Geolocation in a worker.
The page watches only while this device has consent and the document is visible.
It stops the watcher and refresh timer when hidden, disabled, or unmounted.
It ignores late callbacks and fixes older than 5 minutes.
The page sends a fix only to its account-scoped core worker.
It performs no geocoding, map request, or external network request.

The worker uses the bundled GeoNames `cities15000` extract and administrative names.
The extract contains source hashes, a reproducible generator, attribution, and CC BY 4.0 licensing.
The data chunk request contains no coordinates and uses the same origin.
The lookup stores no fix or trail.
It rejects accuracy worse than 5 km and candidates beyond 25 km, including the accuracy radius.
It also rejects comparable candidates from different known regions or countries.
These checks are conservative heuristics, not boundary tests.
A nearby city's region can differ from the fix's jurisdiction.
The UI must therefore display **Near city, region**, never an asserted current city or state.
US and Canadian regions use known postal abbreviations.
Other regions use known names, or remain absent.
Unavailable rural, border, or inaccurate fixes produce no label.

Add `Content.locality`, protobuf tag 14, as a separate MLS application body.
This avoids repeating avatar bytes or modifying profile names during locality updates.
The body contains only city, region, country code, and expiry.
It never contains exact coordinates.
An empty city, region, and country code revoke the sending device's locality.
Use the existing MLS identity binding and current-member checks.
Only accepted, active direct conversations can send or receive locality metadata.
Blocked contacts, message requests, groups, and self conversations cannot receive it.
The header displays locality only beside a direct recipient name, not in the conversation list.

Limit each device to 1 lookup and publication attempt per 15 minutes.
Both updates and revocations have a maximum 1-hour lifetime.
Validate bounded labels, positive safe timestamps, clock tolerance, and expiry in the worker.
Order updates per authenticated sender device and conversation.
A revocation wins an equal-timestamp tie and leaves an ordering tombstone.
Retain tombstones through the maximum replay horizon.
Use a nondecreasing receiver clock so wall-clock rollback does not revive an expired label.
Retain the clock floor in encrypted device-local state.
Discard cached visible places on startup and require fresh updates.
Do not extend an old fix's expiry when introducing it to a new conversation member.

Use the existing ordered outbox with content-free, silent delivery.
Do not delete stale locality ciphertext from that outbox: this can leave MLS receive-ratchet gaps.
Receivers must reject expired updates, including delayed retries.
A revocation follows earlier queued updates and prevents their later display.
Recipients can retain information they already received; revocation is not remote secure deletion.
Offline recipients can retain a label until its expiry or until they receive the revocation.

Consent, coarse cached values, ordering state, and receiver records remain in encrypted local worker storage.
They stay outside backup and device sync.
Backup restore explicitly resets these fields, even if an imported object contains extra fields.
A linked or restored device must obtain its own consent.
Sign-out cancels timers and invalidates pending lookup results.
Every page request includes its expected account to reject stale account callbacks.

## Consequences

The app gains useful approximate locality without sending coordinates to a geocoder or the chat server.
The worker loads about 500 KB of compressed geographical data on first use.
The app can cache its generated chunk for offline use.
The setting does not provide continuous background location.
A direct recipient can learn the sender's approximate area after consent.
The label cannot prove municipal membership, jurisdiction, or physical presence.
Different opted-in devices can share different nearby places.
Turning off one device does not disable another device's independent consent.

## Validation

Test the lookup against near cities, missing regions, inaccurate fixes, distant points, and ambiguous borders.
Test MLS roundtrips for locality updates and revocations.
Test worker eligibility, encrypted persistence, outbox ordering, expiry, replay, clock rollback, and account fencing.
Test that backup and device sync omit locality consent and cached values.
Test that no geolocation call occurs before opt-in.
Test foreground watcher cleanup, late callbacks, permission failure, and the approximate recipient label.
Test the header at phone and desktop widths.

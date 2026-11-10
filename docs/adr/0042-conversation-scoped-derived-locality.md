# ADR-0042: Derive locality only from explicit conversation location shares

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Project owner, implementation agents
- **Related requirements:** FR-LOC-1, FR-LOC-2, FR-LOC-4, issue #132
- **Supersedes:** [ADR-0041](0041-opt-in-automatic-locality.md)
- **Builds on:** ADR-0002, ADR-0026, ADR-0027, ADR-0034, ADR-0037

## Context

The owner rejected the global automatic-location setting and its additional interface text.
Automatic lookup must follow explicit location sharing with a contact, not device-wide consent.
A person already gives conversation-scoped consent through **Send location** or the live-location controls.
Those actions share authenticated coordinates with that conversation's existing recipients.
They must not start a separate service that sends coarse locality to other contacts.

## Options considered

1. Keep the global watcher and separate locality broadcasts from ADR-0041. This does not match the owner's consent model.
2. Add another contact-specific coarse-sharing setting. This adds controls and a separate location-publication mechanism.
3. Derive the recipient header from location messages deliberately shared in that conversation. This uses the existing consent and transport.

## Decision

Use option 3. Retain the offline gazetteer, but remove the global automatic-location service.
This decision supersedes ADR-0041's consent model, watcher, scheduling, and standalone locality publications.

### Consent and scope

**Send location** and the existing live-share controls provide consent for that conversation only.
There is no global automatic-sharing setting, coarse-only broadcast, or separate header geolocation watcher.
Opening a conversation or rendering a recipient name must not request a position.
An operating-system permission grant does not authorize sharing with another contact.
No contact receives location information unless the person explicitly shares a location in that conversation.

Existing one-shot and live-location payloads, recipients, durations, watcher behavior, and Stop controls remain unchanged.
Location shares in groups retain their existing group scope.
They do not authorize direct-contact header updates or copies to other conversations.
The header feature applies only to the peer in an accepted, active, unblocked direct conversation.
It does not publish a profile field or add a conversation-list label.

Clicking the contact name or avatar opens the existing contact-details modal.
That view shows authorized live-location maps and cards already shared in that conversation, under their existing retention and live-expiry rules.
The conversation menu remains a separate control.
Restoring this entry point does not request a position, broaden consent, or reconstruct the header from history.

### Authenticated source and offline lookup

The core worker derives the header only from validated, authenticated `Location` and `LiveLocation` messages in the same conversation.
The source must belong to that conversation's peer, not to this account or another conversation.
Own messages, groups, and message requests cannot supply a header source.
Use existing MLS sender binding and live-session ownership checks.
Only processing a newly accepted eligible location message or live update can establish or refresh the label.
History loading, request acceptance, unblock, and backup restore must not reconstruct a header from retained messages.
Do not derive a header from profile text, free-text place labels, outer envelope identifiers, or legacy standalone locality bodies.

The worker resolves the source coordinates with the bundled GeoNames gazetteer.
Run lazy dataset loading and lookup outside the exclusive receive-processing lock.
The receive path must not await that work while it holds the lock.
Dataset loading must not delay block, stop, sign-out, or membership processing.
After lookup completes, re-enter `exclusive()` only to validate the source and publish the result.
Recheck account, conversation eligibility, current source identity, ordering, expiry, membership, and stop or block tombstones before publication.
A result that fails any check must not update the header.
It must not request a geocoder, coordinate-dependent lookup endpoint, or extra map tiles for this header lookup.
The bundled data chunk uses the same origin and contains no coordinate-dependent URL.
Existing map requests for deliberately shared locations remain unchanged.
The page receives only the derived display value through the normal worker view.
It does not perform lookup or obtain another location fix for the header.

The header must say **Near city, region**, not assert current municipal membership.
US and Canadian regions use validated postal abbreviations.
Other regions use known names or remain absent.
Keep the existing accuracy, distance, and cross-border ambiguity checks.
A point gazetteer cannot prove jurisdiction membership or identify water near a coast.
An unavailable or ambiguous lookup produces no header label.
Retain GeoNames attribution and the CC BY 4.0 license link in the existing location-sharing interface.
Do not add a global automatic-location setting to hold that attribution.

### Freshness and clearing

A header label has a maximum lifetime of **1 hour** from the source message or live update's validated original timestamp.
Receipt, history access, lookup completion, reload, and navigation must not restart that lifetime.
Reject invalid timestamps and apply the existing clock-tolerance rules.
A live-derived label expires at the earlier of that 1-hour limit and the live session's expiry.
A fresh authenticated live point can refresh the label within the same conversation.
An until-stopped session's 8-hour lease must not extend an old header point beyond 1 hour.

Retain each point's authenticated peer account, source device, conversation, validated ordering, and live session identity where applicable.
Device provenance identifies the point's source; it does not restrict stop authority to that device.
Within the conversation, key live-stop tombstones by the canonical peer account and session identity, not the point's device.
Another current authenticated device of that peer account can stop the accepted session under the existing live protocol.
An authorized stop clears the header derived from that account and session when the worker processes the stop.
A stop for an old session must not clear a newer unrelated static share or live session.
Session expiry also clears its derived header without waiting for another message.
Clearing the current source hides the header. It must not restore an older static or live label as a fallback.
A newer eligible explicit share can establish another label.
Delayed or duplicate messages and wall-clock rollback must not revive an expired or stopped label.
Stale lookup results must not override a newer point or restore cleared state.
Account changes, newer sources, expiry, and stops must invalidate pending results for their old source.
Each result must stay bound to its own conversation and peer.

Same-member rekeys and device addition preserve existing live consent.
They must not create a stop tombstone merely because the MLS epoch or device set changes.
Prune removed-device or otherwise ineligible point sources without recording a permanent session stop.
Pruning does not permit history reconstruction; only a fresh eligible authenticated point can establish another header.
Explicit stops and block retain their tombstones so replayed points and delayed lookups cannot revive the cleared source.
Unblock must not remove this protection or reconstruct a header from old messages.

The header lifetime does not change location-message history retention or the existing live-sharing lease.
Recipients can retain information they already received; clearing a header is not remote secure deletion.

### Migration and local state

Remove the old global consent, watcher, refresh timers, publication scheduling, own coarse cache, and received standalone locality records.
Do not migrate global consent into contact consent or resume it after reload, restore, or device linking.
Legacy `Content.locality` bodies must not update the header or create a new share.
Keep the old wire tag reserved; do not reinterpret it as a new share.
Continue normal MLS processing so ignored application bodies do not create receive-ratchet gaps.
Retain already queued legacy MLS locality ciphertext in the ordered outbox; deleting it can create receive-ratchet gaps.
Upgraded recipients consume and ignore those legacy bodies.
Do not generate replacement coarse updates, revocations, or other migration broadcasts.
Older clients can retain previously queued or received locality until its existing expiry.
Migration cannot retract information that a recipient already received.

Keep derived header caches and their ordering state account-scoped and conversation-scoped.
If persisted, use encrypted device-local worker storage.
Exclude these derived values from backup and device sync, including restore paths with obsolete or extra fields.
Do not reconstruct derived headers when loading retained history, accepting a request, unblocking a contact, or restoring a backup.
A fresh eligible authenticated location message or live update can establish a new header after those transitions.
Source location history retains its existing backup and sync policy; this decision does not expand that policy.

## Consequences

The header reuses location information that the peer deliberately shared with this conversation.
It creates no additional location collection, message type, or audience.
The interface needs no extra consent setting or app-wide status text.
Contacts with no eligible fresh location message have no locality label.
A recent label is still approximate and must not imply current physical presence.
The offline dataset, attribution, strict CSP, and core-worker networking boundary remain in place.

## Validation

Test that unrelated contacts and conversations never receive or display a derived label.
Test that own messages, groups, requests, blocked contacts, and legacy standalone locality bodies cannot populate a direct recipient header.
Test explicit one-shot shares, fresh live updates, missing regions, poor accuracy, and ambiguous borders.
Test the 1-hour cap with delayed delivery, history reads, navigation, reload, and clock rollback.
Test live expiry and stop, including stale lookup completion and an older static share that must not reappear.
Test that an old-session stop cannot clear a newer unrelated share.
Test that another current device of the same authenticated peer account can stop an accepted session.
Test source-device provenance separately from account/session stop authority.
Test lazy dataset loading while block, stop, sign-out, and membership processing complete without waiting for lookup.
Test publication-time validation after lookup completes outside the receive lock.
Test that same-member rekeys and device addition preserve live consent.
Test that pruning removed or ineligible sources does not create permanent stop tombstones.
Test that explicit stop and block tombstones still reject replayed or delayed results.
Test that history load, request acceptance, unblock, and restore cannot reconstruct a header.
Test migration, account isolation, backup exclusion, sync exclusion, and restore with obsolete global fields.
Test ordered legacy ciphertext delivery, ignored legacy bodies, and the absence of migration broadcasts.
Test that opening chats and rendering headers request no position and publish no standalone coarse message.
Test that existing manual and live controls retain their recipients, durations, Stop behavior, and permission cleanup.
Test the approximate header and retained attribution at narrow and wide viewport sizes.
Test contact-name and avatar entry points for authorized shared-location cards, separate from the conversation menu.
Opening details must not request a position or reconstruct the header.

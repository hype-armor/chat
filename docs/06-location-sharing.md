# 06 — Location Sharing

**Status:** Draft

## 1. Modes

| Mode | Behaviour |
|------|-----------|
| One-shot | Single location message `{lat, lon, accuracy, timestamp, optional place label}` |
| Live | Sender's device publishes updates for 15 min, 1 h, 8 h or until stopped; recipients see a moving pin |

## 2. Live location design

- A live session is started by an E2EE message with `{session_id,
  expires_at, until_stopped}`. Later E2EE messages move the point.
- Updates are ordinary E2EE application messages, delivered like any
  other: **not** coalesced or dropped by the server (ADR-0027). Dropping
  MLS messages leaves ratchet gaps that can stop a sender's later messages
  decrypting. Updates are sent at most every 10 s (sooner only after 20 m
  of movement, with a 60 s heartbeat), never while offline, and without
  Web Push. A phone coming back online catches up and discards the stale
  points.
- Clients keep only the latest point (no trail) and discard it when the
  session ends.
- Timed sessions expire at their selected end. An until-stopped session
  renews its 8-hour expiry on every update. Recipients discard its point
  after 8 hours without an update.
- The sender keeps an until-stopped session across reloads. It resumes when
  the app opens and obtains a location fix. Resuming keeps the session id
  and updates its original card, even after its lease expired. An explicit
  stop stays final. Each share posts only 1 card in the conversation.
- Clicking the contact name or photo opens the existing contact-details modal,
  where the person can view authorized location maps and cards already shared
  in that conversation. The conversation menu remains a separate control.
  Active live-location cards appear above safety-number verification.
  They update in place and disappear when sharing stops or expires.
  Opening details does not request another position, broaden sharing, or reconstruct
  the approximate header from history.
- Stop = control message `{session_id, stopped}`. The existing protocol checks
  authenticated account/session ownership, not equality with the original source device.
  Another current device of that account can stop the accepted share. Points retain
  their authenticated source-device provenance. Sessions also expire at their end,
  or when the sender leaves or is removed from the group.
- Update cadence: 10 s floor, 20 m movement threshold, 60 s heartbeat
  (ADR-0027). An 8-hour session sends at most 2,880 small updates; an
  until-stopped session can send more over time.
- **Web limitation:** browsers stop `watchPosition` when the tab/PWA is in
  the background or the screen is off. Live sharing from the web only
  updates while the app is visible; the UI must say so ("Sharing pauses
  when the app is closed or in the background"), and recipients see a
  "last updated" time. For an until-stopped share, recipients remove the
  last point after 8 hours without an update. Continuous background sharing
  arrives with native wrappers.

## 2.1. Approximate locality from an explicit share

[ADR-0042](adr/0042-conversation-scoped-derived-locality.md) supersedes ADR-0041's global automatic-location service.
**Send location** and the existing live-share controls supply consent for that conversation only.
There is no global setting, additional geolocation watcher, or standalone coarse-location broadcast.
Opening a chat or showing a contact name must not request a position.
A browser permission grant does not authorize sharing with another contact.
Manual and live shares retain their existing recipients, durations, and controls, including group sharing.

The core worker derives a direct recipient's header only from that peer's authenticated location or live-location messages in the same conversation.
It must not use own messages, groups, requests, another conversation, profile text, or legacy standalone locality messages as a source.
Only accepted, active, unblocked direct conversations can show this header.
History loading, request acceptance, unblock, and restore must not reconstruct the header from retained messages.
The worker uses the bundled GeoNames gazetteer, not a geocoder or extra map requests.
Lazy dataset loading and lookup run outside the exclusive receive-processing lock.
Block, stop, sign-out, and membership processing must not wait for the dataset.
After lookup, re-enter `exclusive()` only to validate the current source and publish the result.
Recheck account, conversation eligibility, source identity, membership, ordering, expiry, and stop or block tombstones.
Reject stale results. This lookup creates no new location message or audience.
The header says **Near city, region** because the data describes nearby places, not municipal boundaries.
US and Canadian regions use known postal abbreviations; other regions use known names or remain absent.
Distant, inaccurate, or ambiguous fixes can produce no label.

The header expires within **1 hour of the source message or live update's validated original timestamp**.
Receipt, history access, lookup, reload, and navigation must not extend that lifetime.
For a live source, use the earlier of this limit and the session's expiry.
Each point retains its authenticated device and session provenance.
Within the conversation, live-stop tombstones use the canonical peer account and session, not the source device.
Another current authenticated device of that peer account can stop the accepted share.
That authorized stop clears the header derived from that account and session when received.
An old-session stop must not clear a newer unrelated static share or live session.
Session expiry also clears its derived header. Clearing the current source hides the header, without an older-label fallback.
Newer eligible explicit shares can establish another label.
Stale lookup results and replayed messages must not revive cleared or expired labels.
The header limit does not shorten the existing live-sharing lease or change location-history retention.

Same-member rekeys and device addition preserve live consent.
Prune removed-device or otherwise ineligible point sources without creating a permanent session stop.
Only a fresh eligible authenticated point can establish another header after pruning; history cannot reconstruct it.
Explicit stops and block retain tombstones that reject replayed points and delayed lookups.
Unblock must not remove this protection or reconstruct a header.

Migration clears the old global consent, coarse caches, scheduling, and watcher state.
Retain already queued legacy MLS locality ciphertext in the ordered outbox to avoid receive-ratchet gaps.
Upgraded recipients consume and ignore legacy locality bodies. Migration must not generate broadcasts.
Older clients can retain previously queued or received locality until its existing expiry; migration cannot retract it.
Derived caches and ordering state remain account-scoped and conversation-scoped in the worker, outside backup and device sync.
Restoring obsolete global fields must not re-enable collection or sharing.
A fresh eligible authenticated location message or live update can establish a new header; history cannot reconstruct one.
Keep GeoNames source attribution and the CC BY 4.0 license link in the existing location-sharing interface.

## 3. Privacy

- Coordinates are never visible to the server (FR-LOC-4).
- **Maps:** fetching map tiles for a coordinate leaks that coordinate to the
  tile provider. Options (ADR-0008):
  1. Platform maps (Apple MapKit / Google Maps SDK) — easy; leaks to
     Apple/Google.
  2. Self-hosted tile proxy (e.g., OpenStreetMap-based) — tiles are requested
     through our server which strips identity; the server learns rough area,
     not who.
  3. Offline vector tiles bundled/downloaded per region — no leak; large
     downloads.
  **Decision (ADR-0008): MapLibre GL JS + Protomaps PMTiles** (OSM-based
  vector tiles in a single file, served by our server or any self-hoster
  with HTTP range requests). Regions can be cached in OPFS for offline
  mode.
- **How it's served (ADR-0026):** one `basemap.pmtiles` file on the web
  pod at `/tiles/`. The core worker reads tiles by range for the page's map
  (a `chat://` protocol), so the page fetches no map data itself. MapLibre 6
  renders text labels with local fonts. The style has no glyph, font, or sprite
  URL. Sprite-only symbols remain disabled. Static locations, sharing previews,
  and live locations show the reported accuracy radius in metres.
- Optional place labels remain part of the sender's encrypted location message.
  The recipient header instead derives **Near city, region** locally from coordinates
  explicitly shared in that conversation (ADR-0042). It does not trust arbitrary
  place labels as a structured locality. The worker-only offline lookup adds no
  coordinate-dependent network request or standalone locality publication.
  It rejects poor fixes, distant places, and comparable cross-border candidates.
  It cannot prove municipal membership or identify water near a coast.
  See `web/src/core/locality-data/README.md` for attribution, data sources,
  regeneration steps, and the distance and accuracy limits.
- Persistent per-conversation indicators during live sharing (FR-LOC-6):
  a location icon in the conversation list and the live-location message card
  with **Stop sharing**. The conversation menu also has **Stop sharing location**
  while a share is active, even when its card is off-screen or its previous
  lease expired before a fresh fix. There is no app-wide location-sharing banner or
  reserved space above the chat layout. OS-level "while using" permission
  is preferred; background permission is only requested when starting a live share.

## 4. Offline mode
Location messages work in offline mode like any other small message; live
updates are throttled more aggressively (mesh bandwidth is scarce) and are
not relayed over more than 2 hops.

## 5. Platform constraints
- Web: Geolocation API needs HTTPS and a user permission prompt; no
  background updates (see §2).
- Native wrappers (later): iOS "Always"/background location session with
  indicator; Android `ACCESS_BACKGROUND_LOCATION` + foreground service of
  type `location`.

# 06 — Location Sharing

**Status:** Draft

## 1. Modes

| Mode | Behaviour |
|------|-----------|
| One-shot | Single location message `{lat, lon, accuracy, timestamp, optional place label}` |
| Live | Sender's device publishes updates for a chosen duration; recipients see a moving pin |

## 2. Live location design

- A live session is started by an E2EE **control message**
  `{session_id, expires_at, update_interval}` in the conversation.
- Updates are ordinary E2EE application messages, flagged *ephemeral* and
  *non-persistent*: the server queues them with a short TTL (e.g., 2 min)
  and replaces older updates from the same session (coalescing key is an
  opaque `session_id`), so offline recipients don't receive a flood of stale
  points on reconnect.
- Clients keep only the latest point (plus optional short trail) and
  discard data when the session ends.
- Stop = control message `{session_id, stopped}`; also auto-stop at
  expiry, on leaving the group, or on removal from the group.
- Update cadence adapts: motion-based (significant-change / fused provider)
  with a floor/ceiling (e.g., 10 s – 2 min) to save battery.
- **Web limitation:** browsers stop `watchPosition` when the tab/PWA is in
  the background or the screen is off. Live sharing from the web only
  updates while the app is open; the UI must say so ("Sharing pauses when
  you leave the app"), and recipients see a "last updated" time. Continuous
  background sharing arrives with native wrappers.

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
  (a `chat://` protocol), so the page fetches no map data itself. Label
  layers wait for self-hosted glyphs.
- Reverse geocoding (place names) is done by the **sender** and sent inside
  the encrypted message, or skipped.
- Persistent UI indicator during live sharing (FR-LOC-6); OS-level
  "while using" permission preferred; background permission only requested
  when starting a live share.

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

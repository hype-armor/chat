# ADR-0026: One-shot locations and serving map tiles

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** project owner, Claude
- **Related requirements:** FR-LOC-1, FR-LOC-4, FR-LOC-5
- **Builds on:** ADR-0008 (MapLibre GL JS + Protomaps PMTiles)

## Context
ADR-0008 chose MapLibre and self-hosted PMTiles. That left three questions:
- where the tile file is served from;
- how map requests fit "networking stays in the core worker";
- how MapLibre, which starts its own Web Worker, fits our strict CSP and
  Trusted Types.

## Decision
- **Message:** a `Location` content body (latitude, longitude, accuracy in
  metres, optional label), encrypted by MLS like any message. The server
  never sees coordinates. Receivers drop impossible values: latitude beyond
  ±90, longitude beyond ±180, accuracy below 0 or above 100 km.
- **Reading the position:** the Geolocation API exists only on the page, so
  the page reads one fix with `getCurrentPosition` when the person taps 📍.
  It shows a preview and hands the point to the core worker to send.
- **Tiles:**
  - one `basemap.pmtiles` file served by the web pod's nginx at `/tiles/`,
    from a read-only volume (a host directory on k3s, or a PVC);
  - operators cut a regional extract once with the `pmtiles` CLI;
  - no tile server process and nothing in the chat server.
- **Map requests go through the core worker.** The page registers a
  `chat://` protocol with MapLibre. Its handler asks the core worker for
  tile `z/x/y`, and the worker reads it from the PMTiles file by HTTP range
  (the `pmtiles` library). The page fetches no map data itself, and every
  request goes to our own origin.
- **No labels yet:** label layers need glyph (font) files, which we don't
  serve yet. The map shows roads, water, parks and buildings. Glyphs can be
  served from `/tiles/` later.
- **Without a basemap:** the map shows a plain background with the pin, and
  the card always shows the coordinates. An "Open in maps app" link
  (`geo:` URI) hands the point to the device's own app only when tapped.
- **MapLibre and Trusted Types:**
  - MapLibre is bundled with the app and loaded only when a map is first
    shown, with its CSS bundled as well.
  - MapLibre 6 starts its worker with `new Worker(url)` from a plain
    string, which `require-trusted-types-for 'script'` blocks.
  - So we add a `default` Trusted Types policy with the same rule as `chat`
    (same-origin script URLs only), and only `createScriptURL`, so HTML and
    script sinks stay blocked.
  - The CSP allows policies `chat default`. MapLibre's worker is a bundled
    file on our origin (`worker-src 'self'`).

## Consequences
- The basemap is an operator step and a few GB to tens of GB of disk. The
  k3s guide gives the commands.
- The page-to-worker hop adds a little latency per tile. Maps are small and
  shown on demand, so it isn't noticeable.
- The app bundle grows by about 1 MB of MapLibre, loaded only on the first
  map and precached for offline use.
- Any library that hands `new Worker()` or `importScripts()` a same-origin
  string is now accepted. Cross-origin script URLs are still refused.
- OSM attribution is shown on the map.

## Validation
- **Unit tests:** coordinates, accuracy and labels are checked on receipt.
- **Browser test:**
  - a position from the browser is previewed, sent, and shown to the other
    member with coordinates and a `geo:` link;
  - the map draws (WebGL canvas and pin in Chromium);
  - no request leaves our origin, and there are no CSP or Trusted Types
    violations.
- **Not yet tested:** a map with real tiles. That needs a PMTiles extract,
  which the tests don't download. It is the first thing to check on the
  dev cluster.

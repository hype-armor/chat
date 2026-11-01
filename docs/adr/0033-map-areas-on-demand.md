# ADR-0033: Map areas downloaded when first shared

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner, Claude
- **Related requirements:** FR-LOC-1, FR-LOC-4, FR-LOC-5
- **Changes:** ADR-0026 (an operator no longer has to cut extracts by hand)

## Context
ADR-0026 serves maps from one PMTiles file the operator extracts by hand
for the regions they expect. The owner asked that areas download by
themselves the first time a location there is shared. The server can't
see shares (they are end-to-end encrypted), and phones must not fetch
tiles from third parties.

## Decision
1. **The server keeps a tile cache by area** (`CHAT_TILES_DIR`). An area
   is one zoom-10 tile, about 40 km across. The first request for a tile
   in an area the server lacks starts a background download of the whole
   area, zoom 10 to 15 (1,365 tiles), from an upstream PMTiles archive
   (`CHAT_TILES_SOURCE`, Protomaps' daily build by default in compose:
   `https://build.protomaps.com/{yesterday}.pmtiles`), read by HTTP range
   with its directories cached. Tiles below zoom 10 are fetched one at a
   time when asked for. Empty places are stored too, so nothing is fetched
   twice. `CHAT_LIMIT_TILES_MAX_REGIONS` (500) caps the cache.
2. **`GET /v1/tiles/{z}/{x}/{y}`** (signed-in devices) serves a tile, `204`
   where the map is empty, or `202` with `Retry-After` while its area
   downloads. Maps wait for it.
3. **Clients start the download when a location is shared, received or
   starts live**: the core worker asks once for the zoom-10 tile of that
   area (once per area per session), so the map is ready when opened. An
   operator's own basemap file (ADR-0026) still takes precedence.
4. **No tile coordinates are logged.**

## Consequences
- **The upstream (Protomaps' CDN) learns which ~40 km areas this server
  wanted and when**: not who shared, or the point within the area. Leave
  `CHAT_TILES_SOURCE` empty to keep the ADR-0026 behaviour (no outside
  requests at all).
- **Our server learns roughly where (about 40 km) a shared location is
  when it is shared or shown**, from the prepare request, where before it
  learned that only when someone opened the map. It still never sees the
  exact point or who it was shared with. This is a deliberate trade for
  maps that are ready on first view.
- The first view of a new area can wait a minute while the area
  downloads. Areas are kept until the cache is cleared; there is no
  eviction yet beyond the cap, which refuses new areas once full.
- Daily builds may change between areas; tiles from different builds sit
  side by side without trouble.

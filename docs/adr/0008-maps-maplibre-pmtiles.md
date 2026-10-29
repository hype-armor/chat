# ADR-0008: Maps: MapLibre GL JS + Protomaps PMTiles

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** FR-LOC-5

## Context
Map tile requests reveal the coordinates being viewed.

## Options considered
1. **Google/Apple maps**: leak locations to third parties.
2. **MapLibre + self-hosted PMTiles**: open, no third party, can be cached offline.
3. **Commercial tile API**: leaks to the vendor, costs money.

## Decision
MapLibre GL JS rendering Protomaps PMTiles served from our own (or the self-hoster's) storage. Users can cache regions in OPFS.

## Consequences
We host a planet tile file (~100 GB for full detail; lower-zoom extracts are smaller). Geocoding is skipped or done on the client.

## Validation
Map loads with no third-party requests (verified in a CSP report).

# ADR-0004: Client UI: TypeScript + React + Vite PWA

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** FR-PLAT-1/2, NFR-UX-*

## Context
We need a fast, accessible, installable web app that open-source contributors can easily work on.

## Options considered
1. **React**: largest contributor pool and ecosystem (WebRTC, MapLibre, accessibility libraries).
2. **SolidJS / Svelte**: smaller and faster bundles, but fewer contributors.
3. **Flutter Web**: one UI for all platforms, but heavy initial download, poor accessibility and text selection on web.

## Decision
TypeScript + React + Vite, with a hand-written service worker (we need the custom update gate from doc 04 §9).

## Consequences
Lazy-load heavy features (calls, maps, media editor) to meet NFR-PERF-6.

## Validation
Lighthouse PWA + accessibility audits pass; first-load budget met.

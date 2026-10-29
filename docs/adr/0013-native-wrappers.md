# ADR-0013: Native wrappers: Capacitor (mobile), Tauri (desktop)

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related requirements:** FR-PLAT-4, FR-OFF-2

## Context
Native wrappers are needed for BLE/Wi-Fi Aware, background behaviour, and call ringing, but must not fork the UI or the core.

## Options considered
1. **Capacitor**: runs the same web UI in a WebView, with native plugins in Swift/Kotlin.
2. **Fully native apps**: best integration, but two more UIs.
3. **React Native**: would mean rewriting the UI.

## Decision
Capacitor for Android and iOS, Tauri for desktop. Native code only moves opaque frames (radio transports) and integrates OS features (CallKit/Telecom, background location); the Rust core stays the single implementation.

## Consequences
WebView quirks on iOS (WKWebView) must be tested. The plugins are platform-specific work.

## Validation
Phase 6 prototypes.

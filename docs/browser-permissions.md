# Browser camera, microphone, and location permissions

## What the app can control

The app requests device access for an explicit action, such as recording a voice note,
scanning a QR code, answering a call, or sharing a location.
It must not request access merely to check permission or display guidance.
It must not keep idle camera or microphone streams to prevent another prompt.
It must stop tracks after cancellation, including tracks returned by a late permission grant.

A browser or operating system controls whether permission persists.
The app cannot force a persistent grant, turn a temporary grant into a persistent grant,
or remember permission in application storage.
Private browsing, temporary grants, permission resets, and device settings can cause another prompt.
A PWA can have permission settings separate from a browser tab.

To manage access, open this site's browser permissions and the device's privacy settings.
If the browser offers a persistent setting, the user can choose it there.
If it offers only temporary access, another prompt can be normal.
Do not enable camera or microphone access unless the requested action needs it.
If a device is unavailable, check whether another app is using it.

`web/src/ui/permissions.ts` provides `permissionGuidance()` for explanatory UI.
It does not query permission, request access, or store permission state.
`MediaCapture` owns one operation and stops tracks when that operation ends.
Create another owner only for another explicit action, not an automatic retry.

## Security headers

`deploy/docker/security-headers.inc.template` allows camera, microphone,
geolocation, and display capture only for the same origin with `Permissions-Policy`.
That header permits feature use; it does not grant permission or change grant lifetime.
The CSP blocks third-party scripts and frames. It does not persist device permission.
Nginx includes these headers for the app shell, assets, service worker, manifest, and map tiles.
`web/vite.config.ts` uses the same headers for preview tests.

The deployed origin must use HTTPS, except for browser-supported local test origins.
Check the actual response headers if a reverse proxy adds another policy.
A stricter policy can block access even when the browser previously granted permission.
Do not weaken the CSP or permission policy to avoid a browser prompt.

## Focused regression checks

Unit tests cover concurrent acquisition, late grants, cancellation, and truthful error guidance.
Call tests cover cancellation before acquisition and the encrypted-media capability guard.
Group-call tests also cover SDK teardown, stale sessions, duplicate device actions, and protected publication.
A group call keeps its joining state until the initial capture is protected and published.
Device controls cannot start a second capture while that initial capture waits.

Run the isolated browser fixture to check React StrictMode, scanner callback changes,
recorder double clicks, startup failures, and device cleanup:

```sh
PW_ALL_BROWSERS=1 pnpm --filter web exec playwright test -c playwright.fixtures.config.ts permissions.fixture.spec.ts
```

Set `E2E_UI_FIXTURE_PORT` to a free port if another fixture uses the default port.
`playwright.permissions.config.ts` also provides a standalone configuration with `E2E_PERMISSION_FIXTURE_PORT`.
The fixture uses fake capture streams. It does not contact a deployed chat service.
It checks application request counts, not actual browser prompt persistence or call transport.

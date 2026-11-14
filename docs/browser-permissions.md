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

## Conversation-scoped location actions

[ADR-0042](adr/0042-conversation-scoped-derived-locality.md) replaces the global automatic-location setting.
The existing **Send location** and live-share controls provide consent for their conversation only.
A location preview can request a browser fix, but only sending or starting a live share transmits that location.
A stored browser grant does not authorize publication to other contacts.
Opening a chat, showing a recipient header, or receiving a location must not request this device's position.

There is no global location watcher, separate coarse-sharing service, or header refresh geolocation request.
The existing live-share watcher runs only for deliberately started shares and keeps its existing visibility and cleanup rules.
A one-shot share must not start ongoing collection.
The core worker derives **Near city, region** only from the peer's authenticated location or live update in that conversation.
The bundled offline lookup does not call a geocoder or send another coordinate-dependent request.
Lazy loading and lookup run outside the receive lock so block, stop, and sign-out do not wait for the dataset.
After lookup, re-enter `exclusive()` only to validate the current source and publish.

The derived header has a maximum 1-hour source lifetime and must clear on its live source's stop or earlier expiry.
Points retain authenticated device provenance, but live-stop authority follows the canonical peer account and session.
Another current authenticated device of that peer account can stop the accepted share.
Same-member rekeys and device addition preserve live consent.
Removed or ineligible sources are pruned without permanent stop tombstones; explicit stops and block retain their tombstones.
History loading and unblock must not reconstruct the label or revive a stopped source.
Migration must clear the old global consent, watcher, scheduling, and coarse caches without starting another permission request.
It must not generate migration broadcasts. Upgraded recipients consume and ignore legacy locality bodies.
Already queued MLS ciphertext stays ordered to avoid receive-ratchet gaps.
Older clients can retain previously queued or received locality until its existing expiry.

Keep GeoNames attribution and its CC BY 4.0 license link in the existing location-sharing interface.
This attribution does not require a global automatic-location control.

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
Location checks must prove that chat navigation, header rendering, history loading, and unblock request no position or standalone coarse publication.
Existing manual and live share checks must retain conversation scope, Stop behavior, and late-callback cleanup.
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

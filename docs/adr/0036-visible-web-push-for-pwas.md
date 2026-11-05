# ADR-0036: Visible Web Push for suspended PWAs

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** project owner, Pi
- **Related requirements:** FR-NOT-1, FR-NOT-2, FR-CALL-5

## Context

On iOS and iPadOS, the operating system can suspend a Home Screen PWA while
its WebSocket still appears open to the server. The current offline-only
push rule can then miss a notification. Safari also requires the service
worker to display a visible notification for every received push.

The owner wants notifications in Notification Center and on the Lock Screen.
The owner accepts generic system notifications while Chat is open.

## Options considered

1. **Keep offline-only push.** This avoids foreground notifications, but it
   relies on the operating system closing the WebSocket before suspension.
2. **Push every non-silent queued envelope.** This works if a mobile PWA is
   suspended, but it can show a generic notification while Chat is open.
3. **Track foreground presence.** This can avoid active alerts, but it needs
   new state and timely visibility updates. The operating system can suspend
   the app before an update reaches the server.

## Decision

For each non-silent queued envelope, the server wakes live WebSockets and
sends Web Push to subscribed devices, even when a socket appears open. The
service worker displays a generic notification for every push. It sends no
message text or sender identity. The server coalesces pushes to at most 1 per
30 s per device. Silent envelopes still send no push.

The server keeps its VAPID key stable and reuses each VAPID JWT for at least
1 hour. iOS and iPadOS users must install the PWA and allow notifications.

## Consequences

- Suspended PWAs can receive notifications even if the server keeps their
  WebSocket sessions.
- Users can receive generic notifications while Chat is open.
- Push services learn the subscription endpoint and delivery timing, but not
  message text or sender identity.
- The server sends more push requests. The 30 s coalescing window limits bursts.
- Operators must keep a stable VAPID private key and set a valid contact.

## Validation

- A server test confirms that a connected device receives both a WebSocket
  delivery and a content-free push.
- A manual iOS test must install Chat from Safari, grant permission, lock the
  device, send a message, and verify Notification Center and Lock Screen.
- Tapping the notification must open or focus Chat.

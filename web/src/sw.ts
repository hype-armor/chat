/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

// Serve the pinned app version offline. A new version only takes over when
// the page asks (after it has been verified — docs/04 §9, Phase 5).
precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting()
})

// Push payloads never carry plaintext (FR-NOT-2). Until the core can
// decrypt inside the service worker, show a generic notification.
self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Chat', { body: 'New message', tag: 'chat-new-message' }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((windows) => windows[0]?.focus() ?? self.clients.openWindow('/')),
  )
})

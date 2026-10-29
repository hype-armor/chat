// Web Push subscription (FR-NOT-1). The subscribe call has to run where a
// service worker registration is available (this thread); the resulting
// subscription holds no message keys and is handed to the core worker,
// which uploads it. Pushes carry no content: the service worker shows a
// generic notification.

import type { CoreClient } from './core/client'

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied'

export function notificationState(): NotificationState {
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    return 'unsupported'
  }
  return Notification.permission
}

/** Decodes a base64url string (the VAPID key) into bytes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

/** Subscribes (or refreshes the subscription) and registers it with the server. */
async function subscribe(core: CoreClient) {
  const registration = await navigator.serviceWorker.ready
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(await core.pushKey()),
    }))
  await core.enablePush(subscription.toJSON())
}

/** Asks for permission (call from a click) and subscribes if granted. */
export async function enableNotifications(core: CoreClient): Promise<NotificationState> {
  const permission = await Notification.requestPermission()
  if (permission === 'granted') await subscribe(core)
  return permission
}

/** On start: keep an already-granted subscription registered (they rotate). */
export async function refreshSubscription(core: CoreClient) {
  if (notificationState() !== 'granted') return
  try {
    await subscribe(core)
  } catch (e) {
    console.warn('push subscription refresh failed', e)
  }
}

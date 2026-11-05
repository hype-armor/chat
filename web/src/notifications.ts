// Web Push subscription (FR-NOT-1). The subscribe call has to run where a
// service worker registration is available (this thread); the resulting
// subscription holds no message keys and is handed to the core worker,
// which uploads it. Pushes carry no content: the service worker shows a
// generic notification.

import type { CoreClient } from './core/client'
import { isInstalled, isIosDevice } from './pwa'

export type NotificationState = 'unsupported' | 'install-required' | 'default' | 'granted' | 'denied'

export function notificationState(): NotificationState {
  if (isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints) && !isInstalled()) {
    return 'install-required'
  }
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

export type PushSetup = {
  registration: ServiceWorkerRegistration
  applicationServerKey: Uint8Array<ArrayBuffer>
}

/** Load browser and server data before the user grants permission. */
export async function preparePush(core: CoreClient): Promise<PushSetup> {
  const current = await navigator.serviceWorker.getRegistration()
  if (!current) throw new Error('Chat needs a service worker. Reload the installed app and try again.')
  const [registration, key] = await Promise.all([navigator.serviceWorker.ready, core.pushKey()])
  return { registration, applicationServerKey: base64UrlToBytes(key) }
}

/** Ask from a tap, then subscribe without another network or worker wait. */
export async function enableNotifications(core: CoreClient, setup: PushSetup): Promise<NotificationState> {
  const state = notificationState()
  if (state === 'unsupported' || state === 'install-required') return state

  const permission = await Notification.requestPermission()
  if (permission === 'granted') await reconnectNotifications(core, setup)
  return permission
}

/** True if the subscription was made with this server's VAPID public key. */
export function usesApplicationKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey
  if (!current) return false
  const bytes = new Uint8Array(current)
  return bytes.length === key.length && bytes.every((b, i) => b === key[i])
}

/**
 * Gets a subscription that the server can push to. A subscription made with an
 * older VAPID key is replaced: the server can't use it, and re-sending it fails.
 */
async function currentSubscription(setup: PushSetup): Promise<PushSubscription> {
  const { registration, applicationServerKey } = setup
  const existing = await registration.pushManager.getSubscription()
  if (existing && usesApplicationKey(existing, applicationServerKey)) return existing
  await existing?.unsubscribe()
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
}

/** Tap-driven: subscribes again even when permission was already granted. */
export async function reconnectNotifications(core: CoreClient, setup: PushSetup): Promise<void> {
  const subscription = await currentSubscription(setup)
  await core.enablePush(subscription.toJSON())
}

/** On start: keep a granted subscription registered, without prompting. */
export async function refreshSubscription(core: CoreClient) {
  if (notificationState() !== 'granted') return
  try {
    await reconnectNotifications(core, await preparePush(core))
  } catch (e) {
    console.warn('push subscription refresh failed', e)
  }
}

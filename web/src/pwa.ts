// Install, storage and update prompts (FR-PLAT-2/3). The decisions are pure
// functions so they can be tested; the browser glue is below them.

import { scriptUrl } from './trusted-types'

/** iOS Safari has no install prompt: people add to the home screen by hand. */
export function isIosSafari(userAgent: string): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) && /Safari/.test(userAgent) && !/CriOS|FxiOS|EdgiOS/.test(userAgent)
}

export type InstallHint = 'prompt' | 'ios' | undefined

/** What to offer for installing: the browser's prompt, the iOS steps, or nothing. */
export function installHint(o: { installed: boolean; promptAvailable: boolean; iosSafari: boolean }): InstallHint {
  if (o.installed) return undefined
  if (o.promptAvailable) return 'prompt'
  return o.iosSafari ? 'ios' : undefined
}

export type StorageState = 'persisted' | 'ask' | 'denied' | 'unsupported'

/** Whether to ask for persistent storage, warn, or say nothing. */
export function storageAdvice(state: StorageState): 'ask' | 'warn' | undefined {
  if (state === 'ask') return 'ask'
  return state === 'denied' ? 'warn' : undefined
}

// ---- browser glue -------------------------------------------------------------

/** The deferred `beforeinstallprompt` event (Chromium only). */
type InstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

let deferredPrompt: InstallPromptEvent | undefined
const installListeners = new Set<() => void>()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e as InstallPromptEvent
    for (const l of installListeners) l()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = undefined
    for (const l of installListeners) l()
  })
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== undefined
}

export function onInstallPromptChange(listener: () => void): () => void {
  installListeners.add(listener)
  return () => installListeners.delete(listener)
}

export async function promptInstall() {
  const prompt = deferredPrompt
  deferredPrompt = undefined
  await prompt?.prompt()
  for (const l of installListeners) l()
}

export function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
}

export async function storageState(): Promise<StorageState> {
  if (!navigator.storage?.persisted) return 'unsupported'
  return (await navigator.storage.persisted()) ? 'persisted' : 'ask'
}

/** Must run from a user gesture: Firefox shows a permission prompt. */
export async function requestPersistentStorage(): Promise<StorageState> {
  if (!navigator.storage?.persist) return 'unsupported'
  return (await navigator.storage.persist()) ? 'persisted' : 'denied'
}

let pendingUpdate: (() => void) | undefined
const updateListeners = new Set<() => void>()

/** Activates a waiting new version, if any; the page reloads once it controls. */
export function updateAvailable(): (() => void) | undefined {
  return pendingUpdate
}

export function onUpdateAvailable(listener: () => void): () => void {
  updateListeners.add(listener)
  return () => updateListeners.delete(listener)
}

/** Registers the service worker and watches for a new version waiting. */
export function registerServiceWorker() {
  const onUpdate = (activate: () => void) => {
    pendingUpdate = activate
    for (const l of updateListeners) l()
  }
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
  navigator.serviceWorker
    .register(scriptUrl('/sw.js'), { type: 'module' })
    .then((registration) => {
      const offer = (worker: ServiceWorker) =>
        onUpdate(() => {
          navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true })
          worker.postMessage({ type: 'ACTIVATE_UPDATE' })
        })
      // An update installed in an earlier visit and still waiting.
      if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting)
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing
        worker?.addEventListener('statechange', () => {
          // With no controller this is the first install, not an update.
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker)
        })
      })
    })
    .catch((e) => console.error('service worker registration failed', e))
}

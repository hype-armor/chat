import { scriptUrl } from './trusted-types'

// Browser capability checks the app depends on (FR-PLAT-*).

export type Capabilities = {
  persistentStorage: boolean | 'unsupported'
  opfs: boolean
  webPush: boolean
  webrtc: boolean
  encodedTransform: boolean
  installed: boolean
}

export async function detectCapabilities(): Promise<Capabilities> {
  return {
    persistentStorage: await requestPersistence(),
    opfs: typeof navigator.storage?.getDirectory === 'function',
    webPush: 'PushManager' in window && 'serviceWorker' in navigator,
    webrtc: 'RTCPeerConnection' in window,
    // Needed for SFrame in group calls (ADR-0006).
    encodedTransform: 'RTCRtpScriptTransform' in window || 'createEncodedStreams' in RTCRtpSender.prototype,
    installed: window.matchMedia('(display-mode: standalone)').matches,
  }
}

/** Asks the browser not to evict our storage (FR-PLAT-3). */
async function requestPersistence(): Promise<boolean | 'unsupported'> {
  if (!navigator.storage?.persist) return 'unsupported'
  return (await navigator.storage.persisted()) || navigator.storage.persist()
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
  navigator.serviceWorker.register(scriptUrl('/sw.js'), { type: 'module' }).catch((e) => {
    console.error('service worker registration failed', e)
  })
}

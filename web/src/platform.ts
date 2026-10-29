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
    persistentStorage: await persistenceState(),
    opfs: typeof navigator.storage?.getDirectory === 'function',
    webPush: 'PushManager' in window && 'serviceWorker' in navigator,
    webrtc: 'RTCPeerConnection' in window,
    // Needed for SFrame in group calls (ADR-0006).
    encodedTransform: 'RTCRtpScriptTransform' in window || 'createEncodedStreams' in RTCRtpSender.prototype,
    installed: window.matchMedia('(display-mode: standalone)').matches,
  }
}

/**
 * Whether storage is already persistent. Only reports: requesting
 * persistence can open a permission prompt (Firefox), so that belongs to an
 * explicit user step after sign-up (FR-PLAT-3), not to page load.
 */
async function persistenceState(): Promise<boolean | 'unsupported'> {
  if (!navigator.storage?.persisted) return 'unsupported'
  return navigator.storage.persisted()
}

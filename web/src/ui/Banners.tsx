import { useEffect, useState } from 'react'
import {
  type StorageState,
  canPromptInstall,
  installHint,
  isInstalled,
  isIosSafari,
  onInstallPromptChange,
  onUpdateAvailable,
  promptInstall,
  requestPersistentStorage,
  storageAdvice,
  storageState,
  updateAvailable,
} from '../pwa'

/** A new app version waiting to take over (service worker update). */
export function UpdateBanner() {
  const [activate, setActivate] = useState(() => updateAvailable())
  useEffect(() => onUpdateAvailable(() => setActivate(() => updateAvailable())), [])
  if (!activate) return null
  return (
    <section className="banner" aria-label="Update">
      <p>A new version of Chat is ready.</p>
      <button type="button" onClick={activate}>
        Update now
      </button>
    </section>
  )
}

/** Offers to install the app (FR-PLAT-2); dismissed for this session. */
export function InstallBanner() {
  const [promptAvailable, setPromptAvailable] = useState(canPromptInstall)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => onInstallPromptChange(() => setPromptAvailable(canPromptInstall())), [])
  const hint = installHint({ installed: isInstalled(), promptAvailable, iosSafari: isIosSafari(navigator.userAgent) })
  if (!hint || dismissed) return null
  return (
    <section className="banner" aria-label="Install">
      {hint === 'prompt' ? (
        <>
          <p>Install Chat for notifications and quicker start-up.</p>
          <button type="button" onClick={() => void promptInstall()}>
            Install
          </button>
        </>
      ) : (
        <p>
          To get notifications on iPhone and iPad, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
        </p>
      )}
      <button type="button" className="link small" onClick={() => setDismissed(true)}>
        Not now
      </button>
    </section>
  )
}

/**
 * Asks the browser not to evict the encrypted keys and messages (FR-PLAT-3),
 * and warns if it won't.
 */
export function StorageBanner() {
  const [state, setState] = useState<StorageState>()
  useEffect(() => {
    void storageState().then(setState)
  }, [])
  const advice = state && storageAdvice(state)
  if (!advice) return null
  return (
    <section className={`banner ${advice === 'warn' ? 'warning' : ''}`} aria-label="Storage">
      {advice === 'ask' ? (
        <>
          <p>Keep your keys and messages safe on this device: let the browser keep this app's data.</p>
          <button type="button" onClick={() => void requestPersistentStorage().then(setState)}>
            Keep data on this device
          </button>
        </>
      ) : (
        <p>
          Your browser may delete this app's data when storage runs low, including your keys and messages. Installing
          the app usually prevents this.
        </p>
      )}
    </section>
  )
}

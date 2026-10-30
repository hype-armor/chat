import { useEffect, useState } from 'react'
import {
  type StorageState,
  type SetupBanner as SetupBannerKind,
  canPromptInstall,
  installHint,
  isInstalled,
  isIosSafari,
  onInstallPromptChange,
  onUpdateAvailable,
  promptInstall,
  requestPersistentStorage,
  readSetupDismissals,
  saveSetupDismissals,
  setupBanner,
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

/** Shared state keeps Settings actions and the single setup banner in sync. */
export function useSetup() {
  const [state, setState] = useState<StorageState>()
  const [promptAvailable, setPromptAvailable] = useState(canPromptInstall)
  const [dismissed, setDismissed] = useState(readSetupDismissals)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    void storageState().then(setState, () => setState('unsupported'))
  }, [])
  useEffect(() => onInstallPromptChange(() => setPromptAvailable(canPromptInstall())), [])
  const installed = isInstalled()
  const hint = installHint({ installed, promptAvailable, iosSafari: isIosSafari(navigator.userAgent) })
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch {
      setError('The browser could not complete this action. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  return {
    state,
    hint,
    installed,
    busy,
    error,
    banner: setupBanner({ storage: state, install: hint, dismissed, now: Date.now() }),
    keepData: () => void run(async () => setState(await requestPersistentStorage())),
    install: () => void run(promptInstall),
    dismiss: (banner: SetupBannerKind) => {
      const next = { ...dismissed, [banner]: Date.now() }
      saveSetupDismissals(next)
      setDismissed(next)
    },
  }
}

type Setup = ReturnType<typeof useSetup>

function InstallAction({ setup }: { setup: Setup }) {
  if (setup.hint === 'ios') {
    return (
      <p>
        To get notifications on iPhone and iPad, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
      </p>
    )
  }
  return (
    <>
      <button type="button" disabled={setup.busy || !setup.hint} onClick={setup.install}>
        Install app
      </button>
      {!setup.hint && (
        <p className="muted small">
          {setup.installed ? 'Chat is installed.' : "Use your browser's menu to install Chat, if supported."}
        </p>
      )}
    </>
  )
}

export function SetupActions({ setup }: { setup: Setup }) {
  return (
    <details className="devices">
      <summary>This device</summary>
      <button
        type="button"
        disabled={setup.busy || !setup.state || setup.state === 'persisted' || setup.state === 'unsupported'}
        onClick={setup.keepData}
      >
        Keep data on this device
      </button>
      {setup.state === 'persisted' && <p className="muted small">Data is kept on this device.</p>}
      {setup.state === 'unsupported' && <p className="muted small">Persistent storage is not supported by this browser.</p>}
      {setup.state === 'denied' && (
        <p className="muted small">Your browser may delete this app's data when storage runs low.</p>
      )}
      <h3>Install app</h3>
      <InstallAction setup={setup} />
      {setup.error && (
        <p role="alert" className="error">{setup.error}</p>
      )}
    </details>
  )
}

/** Only the highest-priority, non-dismissed setup reminder is shown. */
export function SetupBanner({ setup }: { setup: Setup }) {
  const { banner } = setup
  if (!banner) return null
  return (
    <section
      className={`banner ${banner === 'storage-warn' ? 'warning' : ''}`}
      aria-label={banner === 'install' ? 'Install' : 'Storage'}
    >
      {banner === 'install' ? (
        <>
          <p>Install Chat for notifications and quicker start-up.</p>
          <InstallAction setup={setup} />
        </>
      ) : banner === 'storage-ask' ? (
        <>
          <p>Keep your keys and messages safe on this device: let the browser keep this app's data.</p>
          <button type="button" disabled={setup.busy} onClick={setup.keepData}>
            Keep data on this device
          </button>
        </>
      ) : (
        <p>
          Your browser may delete this app's data when storage runs low, including your keys and messages. Installing
          the app usually prevents this.
        </p>
      )}
      <button type="button" className="link small" onClick={() => setup.dismiss(banner)}>
        Not now
      </button>
      {setup.error && (
        <p role="alert" className="error">{setup.error}</p>
      )}
    </section>
  )
}

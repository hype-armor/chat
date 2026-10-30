import { useEffect, useMemo, useState } from 'react'
import { CoreClient } from './core/client'
import type { AppView } from './core/protocol'
import { UpdateBanner } from './ui/Banners'
import { Chat } from './ui/Chat'
import { Diagnostics } from './ui/Diagnostics'
import { Onboarding } from './ui/Onboarding'

/**
 * Keys and storage need WebCrypto, which browsers offer only to secure
 * pages: HTTPS, or http://localhost on the machine itself.
 */
function InsecureOrigin() {
  return (
    <main className="onboarding">
      <h1>Chat</h1>
      <p role="alert">This page must be opened over a secure connection.</p>
      <p className="muted">
        Browsers turn off the encryption this app needs on plain <code>http://</code> pages, except{' '}
        <code>http://localhost</code> on the machine running it. Open it with <code>https://</code>, or from the
        server itself at <code>http://localhost</code>.
      </p>
    </main>
  )
}

export function App() {
  if (!window.isSecureContext || !globalThis.crypto?.subtle) return <InsecureOrigin />
  return <Running />
}

function Running() {
  const core = useMemo(() => CoreClient.start(), [])
  const [view, setView] = useState<AppView>({ phase: 'loading' })
  const [showDiagnostics, setShowDiagnostics] = useState(() => location.hash === '#diagnostics')
  const [failed, setFailed] = useState<string>()

  useEffect(() => {
    const changed = () => setShowDiagnostics(location.hash === '#diagnostics')
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])

  useEffect(() => {
    const unsubscribe = core.subscribe((e) => e.type === 'view' && setView(e.view))
    core
      .view()
      .then(setView)
      .catch((e) => setFailed(e instanceof Error ? e.message : String(e)))
    return unsubscribe
  }, [core])

  return (
    <>
      <UpdateBanner />
      <div hidden={showDiagnostics}>
        {failed && (
          <p className="error center" role="alert">
            The app couldn't start: {failed}
          </p>
        )}
        {view.phase === 'loading' && !failed && <p className="muted center">Loading…</p>}
        {view.phase === 'signed-out' && <Onboarding core={core} notice={view.notice} />}
        {(view.phase !== 'ready' || failed) && (
          <p className="center">
            <button type="button" className="link small" onClick={() => setShowDiagnostics(true)}>
              Diagnostics
            </button>
          </p>
        )}
      </div>
      {view.phase === 'ready' && (
        <Chat
          core={core}
          view={view}
          showDiagnostics={showDiagnostics}
          onDiagnostics={() => setShowDiagnostics(true)}
        />
      )}
      {showDiagnostics && (
        <main>
          <button
            type="button"
            className="link"
            onClick={() => {
              if (location.hash === '#diagnostics') history.replaceState(null, '', location.pathname + location.search)
              setShowDiagnostics(false)
            }}
          >
            ← Back
          </button>
          <Diagnostics core={core} />
        </main>
      )}
    </>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { CoreClient } from './core/client'
import type { AppView } from './core/protocol'
import { Chat } from './ui/Chat'
import { Diagnostics } from './ui/Diagnostics'
import { Onboarding } from './ui/Onboarding'

export function App() {
  const core = useMemo(() => CoreClient.start(), [])
  const [view, setView] = useState<AppView>({ phase: 'loading' })
  const [showDiagnostics, setShowDiagnostics] = useState(() => location.hash === '#diagnostics')

  useEffect(() => {
    const unsubscribe = core.subscribe((e) => e.type === 'view' && setView(e.view))
    core.view().then(setView)
    return unsubscribe
  }, [core])

  return (
    <>
      {view.phase === 'loading' && <p className="muted center">Loading…</p>}
      {view.phase === 'signed-out' && <Onboarding core={core} />}
      {view.phase === 'ready' && <Chat core={core} view={view} />}
      <footer className="footer">
        <button type="button" className="link small" onClick={() => setShowDiagnostics((v) => !v)}>
          {showDiagnostics ? 'Hide diagnostics' : 'Diagnostics'}
        </button>
      </footer>
      {showDiagnostics && <Diagnostics core={core} />}
    </>
  )
}

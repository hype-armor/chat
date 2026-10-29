import { useEffect, useMemo, useState } from 'react'
import { CoreClient } from './core/client'
import type { BenchResult, CoreStatus } from './core/protocol'
import { type Capabilities, detectCapabilities } from './platform'

// Scaffold screen: proves the WASM core, MLS and browser capabilities work
// (Phase 0 spikes a/b). Replaced by the real UI in Phase 1.
export function App() {
  const core = useMemo(() => CoreClient.start(), [])
  const [status, setStatus] = useState<CoreStatus | string>('loading…')
  const [caps, setCaps] = useState<Capabilities>()
  const [bench, setBench] = useState<BenchResult | string>()

  useEffect(() => {
    core.status().then(setStatus, (e: Error) => setStatus(`failed: ${e.message}`))
    detectCapabilities().then(setCaps)
  }, [core])

  const runBench = () => {
    setBench('running…')
    core.bench(50).then(setBench, (e: Error) => setBench(`failed: ${e.message}`))
  }

  return (
    <main>
      <h1>Chat</h1>
      <p className="muted">Development scaffold — not a usable messenger yet.</p>

      <section aria-labelledby="core-heading">
        <h2 id="core-heading">Core</h2>
        {typeof status === 'string' ? (
          <p>{status}</p>
        ) : (
          <dl>
            <dt>Version</dt>
            <dd>{status.version}</dd>
            <dt>MLS self-test</dt>
            <dd data-testid="self-test">{status.selfTest ? 'passed' : 'FAILED'}</dd>
          </dl>
        )}
      </section>

      <section aria-labelledby="bench-heading">
        <h2 id="bench-heading">50-member group benchmark</h2>
        <button type="button" onClick={runBench}>
          Run
        </button>
        {typeof bench === 'string' && <p>{bench}</p>}
        {typeof bench === 'object' && (
          <dl data-testid="bench">
            <dt>Members</dt>
            <dd>{bench.members}</dd>
            <dt>Group setup</dt>
            <dd>{bench.setupMs.toFixed(0)} ms</dd>
            <dt>Key-update commit</dt>
            <dd>
              {bench.commitMs.toFixed(1)} ms (target &lt; 200 ms), {bench.commitBytes} bytes
            </dd>
          </dl>
        )}
      </section>

      <section aria-labelledby="caps-heading">
        <h2 id="caps-heading">Browser capabilities</h2>
        {caps && (
          <dl>
            {Object.entries(caps).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </main>
  )
}

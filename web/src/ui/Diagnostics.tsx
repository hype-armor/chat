import { useEffect, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { BenchResult, CoreStatus } from '../core/protocol'
import { type Capabilities, detectCapabilities } from '../platform'

// Core self-test, MLS benchmark and browser capabilities (Phase 0 spikes).
export function Diagnostics({ core }: { core: CoreClient }) {
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
    <section className="diagnostics" aria-labelledby="diagnostics-heading">
      <h2 id="diagnostics-heading">Diagnostics</h2>
      {typeof status === 'string' ? (
        <p>{status}</p>
      ) : (
        <dl>
          <dt>Core version</dt>
          <dd>{status.version}</dd>
          <dt>MLS self-test</dt>
          <dd data-testid="self-test">{status.selfTest ? 'passed' : 'FAILED'}</dd>
        </dl>
      )}
      <h3>50-member group benchmark</h3>
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
      <h3>Browser capabilities</h3>
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
  )
}

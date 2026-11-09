// UI lifecycle fixture only. Real MLS, lookup and worker policies have separate integration tests.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CoreClient } from '../core/client'
import type { LocalityInfo } from '../core/protocol'
import { AutomaticLocality, AutomaticLocalitySetting } from '../ui/AutomaticLocality'
import '../styles.css'
import '../ui/issue132-chat.css'

type State = { enabled: boolean; status: 'off' | 'locating' | 'ready' | 'unavailable'; locality?: LocalityInfo }
let update: (state: State) => void = () => {}
const activity = { updates: 0, unavailable: 0, settings: [] as boolean[] }
const core = {
  async setLocalitySharing(_account: string, on: boolean) {
    activity.settings.push(on)
    update({ enabled: on, status: on ? 'locating' : 'off' })
  },
  async updateLocality() {
    activity.updates++
    // Model only a worker-derived view. This fixture performs no coordinate lookup.
    update({ enabled: true, status: 'ready', locality: { city: 'Austin', region: 'TX', country: 'US', updatedAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
  },
  async localityUnavailable() {
    activity.unavailable++
    update({ enabled: true, status: 'unavailable' })
  },
} as unknown as CoreClient

function Fixture() {
  const [state, setState] = useState<State>({ enabled: false, status: 'off' })
  update = setState
  return <main style={{ maxWidth: '36rem', padding: '1rem', overflow: 'auto', height: '100%' }}>
    <h1>Automatic locality consent</h1>
    <AutomaticLocalitySetting core={core} account="synthetic-account" enabled={state.enabled} status={state.status} locality={state.locality} />
    <StrictMode>{state.enabled && <AutomaticLocality core={core} account="synthetic-account" enabled />}</StrictMode>
  </main>
}
Object.assign(window, { localityFixture: { activity } })
window.addEventListener('error', (event) => {
  const error = document.createElement('pre')
  error.dataset.testid = 'fixture-error'
  error.textContent = event.message
  document.body.append(error)
})
createRoot(document.getElementById('root')!).render(<Fixture />)

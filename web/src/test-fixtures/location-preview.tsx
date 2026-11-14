// Synthetic location preview with production styles. No server or real fix.
import '../trusted-types'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CoreClient } from '../core/client'
import { ShareLocation } from '../ui/Location'
import '../styles.css'

const originalLocate = navigator.geolocation.getCurrentPosition
let denyNext = false
const maps = new Set<(error: Error) => void>()
navigator.geolocation.getCurrentPosition = (success, failure) => {
  queueMicrotask(() => {
    if (denyNext) {
      denyNext = false
      failure?.({ code: 1, PERMISSION_DENIED: 1, message: 'Synthetic denial' } as GeolocationPositionError)
    } else success({ coords: { latitude: 1, longitude: 2, accuracy: 12 }, timestamp: Date.now() } as GeolocationPosition)
  })
}
let sends = 0
const core = {
  mapInfo: () => new Promise((_resolve, reject) => { maps.add(reject) }),
  sendLocation: async () => { sends++ },
  startLive: async () => { sends++ },
} as unknown as CoreClient
function Fixture() {
  const [error, setError] = useState('')
  return <main>
    <ShareLocation core={core} conversationId="synthetic" onError={setError} onSend={() => undefined}
      trigger={(locate) => <button onClick={() => { setError(''); locate() }}>Preview location</button>} />
    {error && <p role="alert">{error}</p>}
  </main>
}
const root = createRoot(document.getElementById('root')!)
Object.assign(window, { locationPreviewFixture: {
  failMaps: () => { for (const reject of maps) reject(new Error('Synthetic map failure')); maps.clear() },
  denyNext: () => { denyNext = true },
  sends: () => sends,
  restore: () => { root.unmount(); navigator.geolocation.getCurrentPosition = originalLocate },
} })
root.render(<Fixture />)

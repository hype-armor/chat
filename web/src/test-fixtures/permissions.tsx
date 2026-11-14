// Isolated permission lifecycle fixture. It never opens real capture devices.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CoreClient } from '../core/client'
import { Recorder } from '../ui/Recorder'
import { Scanner } from '../ui/Devices'
import { ShareLocation } from '../ui/Location'

let requests = 0
let stops = 0
let recordings = 0
let sent = 0
let failRecorder = false
let grant: { resolve: (stream: MediaStream) => void; reject: (error: Error) => void } | undefined
const originalMedia = navigator.mediaDevices.getUserMedia
const originalRecorder = window.MediaRecorder
const originalPlay = HTMLMediaElement.prototype.play
const originalLocate = navigator.geolocation.getCurrentPosition
let locationRequests = 0
let position: { resolve: PositionCallback; reject?: PositionErrorCallback | null } | undefined
navigator.geolocation.getCurrentPosition = (resolve, reject) => {
  locationRequests++
  position = { resolve, reject }
}
navigator.mediaDevices.getUserMedia = () => {
  requests++
  return new Promise<MediaStream>((resolve, reject) => { grant = { resolve, reject } })
}
HTMLMediaElement.prototype.play = async () => undefined
class FakeRecorder {
  static isTypeSupported() { return true }
  state = 'inactive'
  onstop?: () => void
  ondataavailable?: () => void
  constructor() {
    if (failRecorder) throw new Error('Recorder startup failed')
  }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()) }
}
window.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder
const core = { decodeQr: async () => undefined } as unknown as CoreClient
const root = createRoot(document.getElementById('root')!)
function App() {
  const [recorder, setRecorder] = useState(true)
  const [scanner, setScanner] = useState(false)
  const [locating, setLocating] = useState(true)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  return <main>
    <button onClick={() => setRecorder(false)}>Remove recorder</button>
    <button onClick={() => setScanner(true)}>Open scanner</button>
    <button onClick={() => setScanner(false)}>Remove scanner</button>
    <button onClick={() => setLocating(false)}>Remove location</button>
    <button onClick={() => setRevision((n) => n + 1)}>Render again</button>
    <output aria-label="Revision">{revision}</output>
    {recorder && <Recorder disabled={false} hidden={false} onRecordingChange={(active) => { if (active) recordings++ }}
      onRecorded={() => sent++} onError={setError} />}
    {scanner && <Scanner core={core} accept={() => false} onCode={() => setRevision((n) => n + 1)}
      onClose={() => setScanner(false)} />}
    {locating && <ShareLocation core={core} conversationId="fixture" onSend={() => undefined} onError={setError}
      trigger={(locate) => <button onClick={locate}>Find location</button>} />}
    {error && <p role="alert">{error}</p>}
  </main>
}
Object.assign(window, { permissionFixture: {
  snapshot: () => ({ requests, stops, recordings, sent }),
  resolve: () => {
    const stream = new MediaStream()
    const track = { stop: () => stops++ }
    stream.getTracks = () => [track as unknown as MediaStreamTrack]
    grant?.resolve(stream)
    grant = undefined
  },
  reject: () => { grant?.reject(new DOMException('Denied', 'NotAllowedError')); grant = undefined },
  failRecorder: () => { failRecorder = true },
  locationRequests: () => locationRequests,
  rejectLocation: () => {
    position?.reject?.({ code: 1, PERMISSION_DENIED: 1, message: 'Denied' } as GeolocationPositionError)
    position = undefined
  },
  resolveLocation: () => {
    position?.resolve({ coords: { latitude: 1, longitude: 2, accuracy: 10 } } as GeolocationPosition)
    position = undefined
  },
  restore: () => {
    root.unmount()
    navigator.mediaDevices.getUserMedia = originalMedia
    window.MediaRecorder = originalRecorder
    HTMLMediaElement.prototype.play = originalPlay
    navigator.geolocation.getCurrentPosition = originalLocate
  },
} })
root.render(<StrictMode><App /></StrictMode>)

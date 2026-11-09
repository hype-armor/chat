// Display-only fixture for the real CallScreen and Menu. It does not start a
// call, request media, send signaling, or exercise call-encryption capability.
import { createRoot } from 'react-dom/client'
import { CallScreen } from '../ui/Call'
import type { CallController, CallState } from '../ui/calls'
import '../styles.css'

const state: CallState = {
  callId: 'fixture-call', conversationId: 'fixture-chat', title: 'Bob',
  video: false, outgoing: true, phase: 'active', muted: false,
  cameraOff: false, cameras: 0,
}
const fixture = { selectedOutput: '' }
Object.assign(window, { callMenuFixture: fixture })
const ignore = () => undefined
const calls = {
  current: () => state,
  subscribe: () => ignore,
  setSpeaker: (id: string) => { fixture.selectedOutput = id },
  toggleMute: ignore, hangUp: ignore,
} as unknown as CallController

createRoot(document.getElementById('root')!).render(<CallScreen calls={calls} />)

// The call screen (FR-CALL-1/4/5, ADR-0028): rings for incoming calls
// anywhere in the app, and shows a running call over everything else.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { formatCallDuration } from '../core/calls'
import { Avatar } from './Avatar'
import type { CallController, CallState } from './calls'

export function useCall(calls: CallController): CallState | undefined {
  return useSyncExternalStore(
    (listener) => calls.subscribe(listener),
    () => calls.current(),
  )
}

/** A soft two-tone ring while a call rings; silent where audio can't start yet. */
function useRingtone(on: boolean) {
  useEffect(() => {
    if (!on || typeof AudioContext === 'undefined') return
    const audio = new AudioContext()
    const ring = () => {
      const t = audio.currentTime
      for (const [start, freq] of [
        [0, 440],
        [0.4, 480],
      ]) {
        const osc = audio.createOscillator()
        const gain = audio.createGain()
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.08, t + start)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.35)
        osc.connect(gain).connect(audio.destination)
        osc.start(t + start)
        osc.stop(t + start + 0.4)
      }
    }
    ring()
    const timer = setInterval(ring, 2_500)
    return () => {
      clearInterval(timer)
      void audio.close()
    }
  }, [on])
}

function Video({ stream, muted, label }: { stream?: MediaStream; muted?: boolean; label: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== (stream ?? null)) ref.current.srcObject = stream ?? null
  })
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} />
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1_000)
    return () => clearInterval(timer)
  }, [])
  return <span className="call-status">{formatCallDuration(Date.now() - since)}</span>
}

const STATUS: Record<CallState['phase'], string> = {
  incoming: 'Incoming call',
  calling: 'Calling…',
  connecting: 'Connecting…',
  active: '',
  ended: '',
}

export function CallScreen({ calls }: { calls: CallController }) {
  const call = useCall(calls)
  useRingtone(call?.phase === 'incoming' || call?.phase === 'calling')
  if (!call) return null
  const what = call.video ? 'video call' : 'voice call'
  const showVideo = call.video && call.phase !== 'incoming' && call.phase !== 'ended'
  const hasRemoteVideo = !!call.remote?.getVideoTracks().length
  return (
    <div
      className={`call-screen ${showVideo ? 'with-video' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={call.phase === 'incoming' ? `Incoming ${what} from ${call.title}` : `Call with ${call.title}`}
    >
      {showVideo && (
        <div className="call-videos">
          <Video stream={call.remote} label={`${call.title}'s video`} />
          {!call.cameraOff && <Video stream={call.local} muted label="Your video" />}
        </div>
      )}
      {/* Voice calls (and answers without video) still need the remote audio. */}
      {!showVideo && call.remote && (
        <div className="call-audio">
          <Video stream={call.remote} label={`${call.title}'s audio`} />
        </div>
      )}
      <div className={`call-info ${showVideo && hasRemoteVideo ? 'over-video' : ''}`}>
        {!(showVideo && hasRemoteVideo) && <Avatar name={call.title} id={call.conversationId} />}
        <h2>{call.title}</h2>
        {call.phase === 'active' && call.connectedAt !== undefined ? (
          <Elapsed since={call.connectedAt} />
        ) : (
          <span className="call-status" role="status">
            {call.phase === 'ended' ? call.ended : call.phase === 'incoming' ? `Incoming ${what}` : STATUS[call.phase]}
          </span>
        )}
        <span className="small muted">End-to-end encrypted</span>
      </div>
      <div className="call-actions">
        {call.phase === 'incoming' && (
          <>
            <button type="button" className="call-button decline" onClick={() => void calls.decline()}>
              Decline
            </button>
            {call.video && (
              <button type="button" className="call-button" onClick={() => void calls.accept(false)}>
                Answer without video
              </button>
            )}
            <button type="button" className="call-button accept" onClick={() => void calls.accept(true)}>
              Answer
            </button>
          </>
        )}
        {(call.phase === 'calling' || call.phase === 'connecting' || call.phase === 'active') && (
          <>
            <button type="button" className="call-button" aria-pressed={call.muted} onClick={() => calls.toggleMute()}>
              {call.muted ? 'Unmute' : 'Mute'}
            </button>
            {call.video && call.local?.getVideoTracks().length ? (
              <button
                type="button"
                className="call-button"
                aria-pressed={call.cameraOff}
                onClick={() => calls.toggleCamera()}
              >
                {call.cameraOff ? 'Camera on' : 'Camera off'}
              </button>
            ) : null}
            <button type="button" className="call-button decline" onClick={() => void calls.hangUp()}>
              Hang up
            </button>
          </>
        )}
        {call.phase === 'ended' && (
          <button type="button" className="call-button" onClick={() => calls.close()}>
            Close
          </button>
        )}
      </div>
    </div>
  )
}

// The call screen (FR-CALL-1/4/5, ADR-0028): rings for incoming calls
// anywhere in the app, and shows a running call over everything else.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { formatCallDuration } from '../core/calls'
import { Avatar } from './Avatar'
import { Menu } from './Menu'
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

type SinkElement = HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }

function Video({ stream, muted, label, sink }: { stream?: MediaStream; muted?: boolean; label: string; sink?: string }) {
  const ref = useRef<SinkElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== (stream ?? null)) ref.current.srcObject = stream ?? null
  })
  useEffect(() => {
    if (sink !== undefined) void ref.current?.setSinkId?.(sink).catch(() => undefined)
  }, [sink])
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} />
}

/** Audio outputs to choose from, where the browser can switch (`setSinkId`). */
function useSpeakers(active: boolean): MediaDeviceInfo[] {
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    if (!active || !('setSinkId' in HTMLMediaElement.prototype)) return
    void navigator.mediaDevices
      .enumerateDevices()
      .then((d) => setSpeakers(d.filter((x) => x.kind === 'audiooutput' && x.deviceId)))
      .catch(() => undefined)
  }, [active])
  return speakers
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
  const speakers = useSpeakers(call?.phase === 'active')
  if (!call) return null
  const what = call.video ? 'video call' : 'voice call'
  const showVideo = call.video && call.phase !== 'incoming' && call.phase !== 'ended'
  const hasRemoteVideo = !!call.remote?.getVideoTracks().length
  const ongoing = call.phase === 'calling' || call.phase === 'connecting' || call.phase === 'active'
  const options = [
    ...(call.video && call.cameras > 1 && !call.cameraOff && !call.sharing
      ? [{ label: 'Switch camera', onSelect: () => void calls.switchCamera() }]
      : []),
    ...(speakers.length > 0
      ? [
          { label: 'Audio output: Default speaker', onSelect: () => calls.setSpeaker('') },
          ...speakers.map((speaker) => ({
            label: `Audio output: ${speaker.label || 'Speaker'}`,
            onSelect: () => calls.setSpeaker(speaker.deviceId),
          })),
        ]
      : []),
  ]
  return (
    <div
      className={`call-screen ${showVideo ? 'with-video' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={call.phase === 'incoming' ? `Incoming ${what} from ${call.title}` : `Call with ${call.title}`}
    >
      {showVideo && (
        <div className="call-videos">
          <Video stream={call.remote} label={`${call.title}'s video`} sink={call.speaker} />
          {(!call.cameraOff || call.sharing) && <Video stream={call.local} muted label="Your video" />}
        </div>
      )}
      {/* Voice calls (and answers without video) still need the remote audio. */}
      {!showVideo && call.remote && (
        <div className="call-audio">
          <Video stream={call.remote} label={`${call.title}'s audio`} sink={call.speaker} />
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
        {call.phase === 'active' && call.quality === 'poor' && (
          <span className="small" role="note">
            Poor connection: sending less video
          </span>
        )}
      </div>
      <div className={`call-actions ${ongoing ? 'call-controls' : ''}`}>
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
        {ongoing && (
          <>
            <button
              type="button"
              className="call-button call-control"
              aria-label={call.muted ? 'Unmute' : 'Mute'}
              aria-pressed={call.muted}
              onClick={() => calls.toggleMute()}
            >
              <span aria-hidden="true">🎤</span>
            </button>
            {call.video && call.local?.getVideoTracks().length ? (
              <button
                type="button"
                className="call-button call-control"
                aria-label={call.cameraOff ? 'Camera on' : 'Camera off'}
                aria-pressed={call.cameraOff}
                onClick={() => calls.toggleCamera()}
              >
                <span aria-hidden="true">📷</span>
              </button>
            ) : null}
            {call.video && 'getDisplayMedia' in (navigator.mediaDevices ?? {}) && (
              <button
                type="button"
                className="call-button call-control"
                aria-label={call.sharing ? 'Stop sharing' : 'Share screen'}
                aria-pressed={!!call.sharing}
                onClick={() => void calls.toggleScreenShare()}
              >
                <span aria-hidden="true">🖥</span>
              </button>
            )}
            {options.length > 0 && (
              <Menu triggerLabel="More call options" triggerContent={<span aria-hidden="true">⋯</span>} items={options} />
            )}
            <button
              type="button"
              className="call-button call-control decline"
              aria-label="Hang up"
              onClick={() => void calls.hangUp()}
            >
              <span aria-hidden="true">☎</span>
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

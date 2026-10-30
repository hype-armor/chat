// The group call screen (FR-CALL-2/6, ADR-0031): up to 16 video tiles,
// everyone else by name; mute, camera and leave.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Avatar } from './Avatar'
import { type GroupCallController, type GroupCallState, MAX_VIDEO_TILES, type Tile } from './groupCall'

export function useGroupCall(calls: GroupCallController): GroupCallState | undefined {
  return useSyncExternalStore(
    (listener) => calls.subscribe(listener),
    () => calls.current(),
  )
}

function TrackElement({ track, kind, label }: { track: MediaStreamTrack; kind: 'video' | 'audio'; label: string }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = new MediaStream([track])
    return () => {
      el.srcObject = null
    }
  }, [track])
  return kind === 'video' ? (
    <video ref={ref} autoPlay playsInline muted aria-label={label} />
  ) : (
    <audio ref={ref} autoPlay aria-label={label} />
  )
}

function TileView({ tile }: { tile: Tile }) {
  return (
    <figure className={`tile ${tile.speaking ? 'speaking' : ''}`} data-testid="call-tile">
      {tile.video ? (
        <TrackElement track={tile.video} kind="video" label={`${tile.name}'s video`} />
      ) : (
        <Avatar name={tile.name} id={tile.id} />
      )}
      <figcaption>
        {tile.name}
        {tile.muted ? ' · muted' : ''}
      </figcaption>
    </figure>
  )
}

export function GroupCallScreen({ calls }: { calls: GroupCallController }) {
  const call = useGroupCall(calls)
  if (!call) return null
  const what = call.video ? 'video call' : 'voice call'
  if (call.phase === 'incoming') {
    return (
      <div className="call-prompt" role="dialog" aria-label={`Group ${what} in ${call.title}`}>
        <span>
          {call.video ? '🎥' : '📞'} Group {what} in <strong>{call.title}</strong>
        </span>
        <span className="call-actions">
          <button type="button" className="link" onClick={() => calls.dismiss()}>
            Not now
          </button>
          <button type="button" className="call-button accept" onClick={() => void calls.accept(true)}>
            Join
          </button>
        </span>
      </div>
    )
  }
  const withVideo = call.tiles.filter((t) => t.video).slice(0, MAX_VIDEO_TILES)
  const others = call.tiles.filter((t) => !withVideo.includes(t))
  return (
    <div className="call-screen group" role="dialog" aria-modal="true" aria-label={`Group call in ${call.title}`}>
      <div className="call-info">
        <h2>{call.title}</h2>
        <span className="call-status" role="status">
          {call.phase === 'joining'
            ? 'Joining…'
            : call.phase === 'ended'
              ? call.ended
              : `${call.tiles.length} in the call`}
        </span>
        <span className="small muted">End-to-end encrypted</span>
      </div>
      {call.phase === 'active' && (
        <div className="call-grid">
          {[...withVideo, ...others.slice(0, Math.max(0, MAX_VIDEO_TILES - withVideo.length))].map((t) => (
            <TileView key={t.id} tile={t} />
          ))}
        </div>
      )}
      {others.length > MAX_VIDEO_TILES - withVideo.length && (
        <p className="small">Also here: {others.slice(MAX_VIDEO_TILES - withVideo.length).map((t) => t.name).join(', ')}</p>
      )}
      <div className="call-audio">
        {call.tiles
          .filter((t) => t.audio)
          .map((t) => (
            <TrackElement key={t.id} track={t.audio!} kind="audio" label={`${t.name}'s audio`} />
          ))}
      </div>
      <div className="call-actions">
        {call.phase === 'active' && (
          <>
            <button type="button" className="call-button" aria-pressed={call.muted} onClick={() => void calls.toggleMute()}>
              {call.muted ? 'Unmute' : 'Mute'}
            </button>
            <button
              type="button"
              className="call-button"
              aria-pressed={call.cameraOff}
              onClick={() => void calls.toggleCamera()}
            >
              {call.cameraOff ? 'Camera on' : 'Camera off'}
            </button>
          </>
        )}
        {call.phase === 'ended' ? (
          <button type="button" className="call-button" onClick={() => calls.dismiss()}>
            Close
          </button>
        ) : (
          <button type="button" className="call-button decline" onClick={() => void calls.leave()}>
            Leave
          </button>
        )}
      </div>
    </div>
  )
}

// Live location (FR-LOC-2/3/6, doc 06 §2). The page watches the position
// (the Geolocation API exists only here) while this device shares, and
// hands each fix to the core worker, which decides what to send.
import { useEffect, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { ChatMessage, LiveInfo } from '../core/protocol'
import { formatCoordinates } from './Location'
import { MapView } from './MapView'

function remaining(expiresAt: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left` : `${minutes} min left`
}

/** The time now, re-rendering every `everyMs` so countdowns move. */
function useNow(everyMs: number): number {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return Date.now()
}

/** The persistent indicator while this device shares (FR-LOC-6). */
export function LiveBanner({
  core,
  sharing,
}: {
  core: CoreClient
  sharing: { conversationId: string; title: string; expiresAt: number }[]
}) {
  const now = useNow(30_000)
  const active = sharing.length > 0

  useEffect(() => {
    if (!active || !navigator.geolocation) return
    const watch = navigator.geolocation.watchPosition(
      (p) =>
        void core
          .liveUpdate({
            latitude: p.coords.latitude,
            longitude: p.coords.longitude,
            accuracyM: Math.round(p.coords.accuracy),
          })
          .catch((e) => console.warn('live update failed', e)),
      (e) => console.warn('location unavailable', e.message),
      { enableHighAccuracy: true, maximumAge: 10_000 },
    )
    return () => navigator.geolocation.clearWatch(watch)
  }, [core, active])

  if (!active) return null
  return (
    <div className="live-banner" role="status" aria-label="Sharing live location">
      {sharing.map((s) => (
        <span key={s.conversationId}>
          📍 Sharing live location with {s.title} · {remaining(s.expiresAt, now)}{' '}
          <button type="button" className="link" onClick={() => void core.stopLive(s.conversationId)}>
            Stop
          </button>
        </span>
      ))}
      <span className="small">Sharing pauses while the app is closed.</span>
    </div>
  )
}

/** A live location in the conversation; its pin moves as updates arrive. */
export function LiveCard({
  core,
  conversationId,
  message,
  live,
}: {
  core: CoreClient
  conversationId: string
  message: ChatMessage
  live: LiveInfo
}) {
  const now = useNow(15_000)
  const [map, setMap] = useState(true)
  if (live.ended || !live.latest) {
    return (
      <div className="location" data-testid="live-location">
        <span>📍 Live location ended</span>
      </div>
    )
  }
  const ago = Math.max(0, Math.round((now - live.latest.at) / 60_000))
  const until = new Date(live.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="location" data-testid="live-location">
      <span>📍 Live location · until {until}</span>
      <span className="small muted">
        {formatCoordinates(live.latest)} · ±{live.latest.accuracyM} m · updated{' '}
        {ago === 0 ? 'just now' : `${ago} min ago`}
      </span>
      {map && <MapView core={core} latitude={live.latest.latitude} longitude={live.latest.longitude} />}
      <span className="small">
        <button type="button" className="link small" onClick={() => setMap(!map)}>
          {map ? 'Hide map' : 'Show map'}
        </button>
        {message.from === 'me' && (
          <>
            {' · '}
            <button type="button" className="link small" onClick={() => void core.stopLive(conversationId)}>
              Stop sharing
            </button>
          </>
        )}
      </span>
    </div>
  )
}

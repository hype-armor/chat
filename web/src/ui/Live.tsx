// Live location (FR-LOC-2/3/6, doc 06 §2). The page watches the position
// (the Geolocation API exists only here) while this device shares, and
// hands each fix to the core worker, which decides what to send.
import { useEffect, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { ChatMessage, LiveInfo } from '../core/protocol'
import { formatCoordinates } from './Location'
import { MapView } from './MapView'

/** The time now, re-rendering every `everyMs` so countdowns move. */
function useNow(everyMs: number): number {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return Date.now()
}

/** One live-location share from this device (FR-LOC-6). */
export type LiveShare = { conversationId: string; title: string; expiresAt: number; untilStopped: boolean }

/** Keeps sharing running while this device has active shares. It draws nothing. */
export function LiveSharing({
  core,
  sharing,
}: {
  core: CoreClient
  sharing: LiveShare[]
}) {
  const active = sharing.length > 0

  useEffect(() => {
    if (!active) return
    if (!navigator.geolocation) {
      void core.pauseLive().catch((e) => console.warn('pausing live location failed', e))
      return
    }

    let watch: number | undefined
    const pause = () => {
      if (watch !== undefined) {
        navigator.geolocation.clearWatch(watch)
        watch = undefined
      }
      void core.pauseLive().catch((e) => console.warn('pausing live location failed', e))
    }
    const start = () => {
      if (watch !== undefined || document.visibilityState !== 'visible') return
      watch = navigator.geolocation.watchPosition(
        (p) => {
          if (document.visibilityState !== 'visible') return
          void core
            .liveUpdate({
              latitude: p.coords.latitude,
              longitude: p.coords.longitude,
              accuracyM: Math.round(p.coords.accuracy),
            })
            .catch((e) => console.warn('live update failed', e))
        },
        (e) => {
          console.warn('location unavailable', e.message)
          void core.pauseLive().catch((error) => console.warn('pausing live location failed', error))
        },
        { enableHighAccuracy: true, maximumAge: 10_000 },
      )
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') start()
      else pause()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    onVisibilityChange()
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      pause()
    }
  }, [core, active])

  return null
}

/** Active shares from this contact in this conversation only; never one-shot or expired points. */
export function contactLiveLocations(messages: ChatMessage[], account: string, now: number): ChatMessage[] {
  return messages.filter((m) =>
    m.from === account && m.live && !m.live.ended && !m.live.stopped && m.live.latest && m.live.expiresAt > now,
  )
}

/** The contact-name/avatar details view keeps live locations above verification. */
export function ContactLiveLocations({
  core,
  conversationId,
  account,
  messages,
}: {
  core: CoreClient
  conversationId: string
  account: string
  messages: ChatMessage[]
}) {
  const now = useNow(15_000)
  const locations = contactLiveLocations(messages, account, now)
  if (locations.length === 0) return null
  return (
    <section aria-label="Contact live location" className="contact-live-location">
      <h3>Live location</h3>
      {locations.map((message) => (
        <LiveCard key={message.id} core={core} conversationId={conversationId} message={message} live={message.live!} />
      ))}
    </section>
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
  if (live.ended || live.stopped || live.expiresAt <= now || !live.latest) {
    return (
      <div className="location" data-testid="live-location">
        <span>📍 Live location ended</span>
      </div>
    )
  }
  const ago = Math.max(0, Math.round((now - live.latest.at) / 60_000))
  const until = new Date(live.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const duration = live.untilStopped ? 'until stopped' : `until ${until}`
  return (
    <div className="location" data-testid="live-location">
      <span>📍 Live location · {duration}</span>
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

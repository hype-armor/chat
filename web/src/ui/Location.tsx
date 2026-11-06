// Locations shared once (FR-LOC-1): a card in the conversation, and the
// share flow in the composer. Coordinates are read here (the Geolocation API
// exists only on the page) and handed to the core worker to encrypt.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { LocationInfo } from '../core/protocol'
import { MapView } from './MapView'
import { isApple, mapsAppLink } from './mapsLink'

const APPLE = typeof navigator !== 'undefined' && isApple(navigator.userAgent, navigator.maxTouchPoints ?? 0)

const LIVE_CHOICES: { label: string; durationMs: number | null }[] = [
  { label: '15 min', durationMs: 15 * 60_000 },
  { label: '1 hour', durationMs: 60 * 60_000 },
  { label: '8 hours', durationMs: 8 * 60 * 60_000 },
  { label: 'Until stopped', durationMs: null },
]

export function formatCoordinates(l: LocationInfo): string {
  return `${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)}`
}

export function LocationCard({ core, location }: { core: CoreClient; location: LocationInfo }) {
  const [map, setMap] = useState(false)
  return (
    <div className="location" data-testid="location">
      <span>📍 {location.label ?? 'Location'}</span>
      <span className="small muted">
        {formatCoordinates(location)} · ±{location.accuracyM} m
      </span>
      {map && <MapView core={core} latitude={location.latitude} longitude={location.longitude} />}
      <span className="small">
        <button type="button" className="link small" onClick={() => setMap(!map)}>
          {map ? 'Hide map' : 'Show map'}
        </button>
        {' · '}
        {/* Hands the point to the device's own maps app, only when tapped. */}
        <a
          className="small"
          href={mapsAppLink(location.latitude, location.longitude, location.label, APPLE)}
          target={APPLE ? '_blank' : undefined}
          rel="noopener noreferrer"
        >
          Open in maps app
        </a>
      </span>
    </div>
  )
}

/** The composer's location action: find the position, preview it, send it. */
export function ShareLocation({
  core,
  conversationId,
  trigger,
  onError,
  onSend,
}: {
  core: CoreClient
  conversationId: string
  trigger: (locate: () => void) => ReactNode
  onError: (message: string) => void
  onSend: () => void
}) {
  const [state, setState] = useState<'idle' | 'locating' | LocationInfo>('idle')
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (typeof state === 'object') dialog.current?.showModal()
  }, [state])

  const close = () => {
    dialog.current?.close()
    setState('idle')
  }

  const locate = () => {
    if (state !== 'idle') return
    if (!navigator.geolocation) return onError("This browser can't share a location")
    setState('locating')
    navigator.geolocation.getCurrentPosition(
      (p) =>
        setState({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracyM: Math.round(p.coords.accuracy),
        }),
      (e) => {
        close()
        onError(e.code === e.PERMISSION_DENIED ? 'Allow location access to share where you are' : "Couldn't find your location")
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 },
    )
  }

  const send = async (location: LocationInfo) => {
    close()
    onSend()
    try {
      await core.sendLocation(conversationId, location)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const live = async (location: LocationInfo, durationMs: number | null) => {
    close()
    onSend()
    try {
      await core.startLive(conversationId, durationMs, location)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      {trigger(locate)}
      {state === 'locating' && <span className="location-progress small" role="status">Finding location…</span>}
      {typeof state === 'object' && (
        <dialog className="share-location" ref={dialog} aria-label="Share this location?" onCancel={close}>
          <MapView core={core} latitude={state.latitude} longitude={state.longitude} />
          <p className="small">
            {formatCoordinates(state)} · ±{state.accuracyM} m. Only the people in this conversation will see it.
          </p>
          <div className="actions">
            <button type="button" onClick={() => void send(state)}>
              Send location
            </button>
            <h3 className="small">Share live location for</h3>
            <div className="live-choices" role="group" aria-label="Share live location for">
              {LIVE_CHOICES.map(({ label, durationMs }) => (
                <button key={label} type="button" className="secondary" onClick={() => void live(state, durationMs)}>
                  {label}
                </button>
              ))}
            </div>
            <p className="small muted">
              Live sharing pauses when this app is closed or in the background.
              Recipients remove the last point after 8 hours without an update.
            </p>
            <button type="button" className="link" onClick={close}>
              Cancel
            </button>
          </div>
        </dialog>
      )}
    </>
  )
}

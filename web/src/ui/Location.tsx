// Locations shared once (FR-LOC-1): a card in the conversation, and the
// share flow in the composer. Coordinates are read here (the Geolocation API
// exists only on the page) and handed to the core worker to encrypt.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { LocationInfo } from '../core/protocol'
import { MapView } from './MapView'

const LIVE_CHOICES: [string, number][] = [
  ['15 min', 15 * 60_000],
  ['1 hour', 60 * 60_000],
  ['8 hours', 8 * 60 * 60_000],
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
        <a className="small" href={`geo:${location.latitude},${location.longitude}`}>
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

  const live = async (location: LocationInfo, durationMs: number) => {
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
          <span className="actions">
            <button type="button" onClick={() => void send(state)}>
              Send location
            </button>
            <span className="small">Share live for</span>
            {LIVE_CHOICES.map(([label, ms]) => (
              <button key={ms} type="button" className="secondary" onClick={() => void live(state, ms)}>
                {label}
              </button>
            ))}
            <button type="button" className="link" onClick={close}>
              Cancel
            </button>
          </span>
        </dialog>
      )}
    </>
  )
}

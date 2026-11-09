import { useEffect, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { LocalityInfo } from '../core/protocol'
import { LOCALITY_REFRESH_MS, localityLabel } from '../core/locality'
import { permissionGuidance } from './permissions'

/** The Geolocation API is page-only. Lookup, encryption and storage stay in the worker. */
export function AutomaticLocality({ core, account, enabled }: { core: CoreClient; account: string; enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let failed = false
    let generation = 0
    let watch: number | undefined
    let refresh: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      generation++
      if (watch !== undefined) navigator.geolocation?.clearWatch(watch)
      watch = undefined
      clearInterval(refresh)
      refresh = undefined
    }
    const start = () => {
      stop()
      if (disposed || failed || document.visibilityState !== 'visible') return
      const current = generation
      const valid = () => !disposed && current === generation && document.visibilityState === 'visible'
      const unavailable = () => {
        if (!valid()) return
        failed = true
        stop()
        void core.localityUnavailable(account).catch(() => {})
      }
      if (!navigator.geolocation) { unavailable(); return }
      const success = (position: GeolocationPosition) => {
        if (!valid()) return
        const age = Date.now() - position.timestamp
        if (!Number.isFinite(age) || age > 5 * 60_000 || age < -2_000) { unavailable(); return }
        const { latitude, longitude, accuracy } = position.coords
        void core.updateLocality(account, { latitude, longitude, accuracyM: accuracy }).catch(unavailable)
      }
      const options = { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 }
      try {
        watch = navigator.geolocation.watchPosition(success, unavailable, options)
        // Refresh a stationary fix too. Never retain a coordinate between callbacks.
        refresh = setInterval(() => {
          if (valid()) navigator.geolocation.getCurrentPosition(success, unavailable, options)
        }, LOCALITY_REFRESH_MS)
      } catch { unavailable() }
    }
    const visibility = () => {
      if (document.visibilityState === 'visible') start()
      else stop()
    }
    document.addEventListener('visibilitychange', visibility)
    // StrictMode replays setup before this microtask. Do not request twice.
    queueMicrotask(() => { if (!disposed) start() })
    return () => {
      disposed = true
      stop()
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [core, account, enabled])
  return null
}

export function AutomaticLocalitySetting({ core, account, enabled, status, locality }: {
  core: CoreClient
  account: string
  enabled: boolean
  status?: 'off' | 'locating' | 'ready' | 'unavailable'
  locality?: LocalityInfo
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <div className="issue132-locality-setting">
    <label>
      <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => {
        const on = event.target.checked
        setBusy(true)
        setError('')
        void core.setLocalitySharing(account, on).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'Could not change locality sharing')
        }).finally(() => setBusy(false))
      }} />
      <span>Automatic current location</span>
    </label>
    <p className="muted small">Off by default. Share an approximate nearby city and state with accepted one-to-one chats. This device updates while the app is visible. Exact coordinates stay on this device for the offline lookup and are not shared by this setting.</p>
    <p className="muted small">The label says “Near” because the offline city data does not prove your city or state boundaries. Rural, border, or inaccurate fixes may have no result. Updates expire within 1 hour. Turning this off sends an encrypted removal; offline recipients may receive it later. Other devices have separate settings.</p>
    {enabled && <p role="status" className="small">
      {locality ? `Sharing: ${localityLabel(locality)}` : status === 'unavailable'
        ? 'Current city unavailable. No current city is shared. Check location access, or turn this setting off and on to retry.'
        : 'Finding a nearby city…'}
    </p>}
    <p className="muted small">{permissionGuidance('location')} Locality data: <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>.</p>
    {error && <p role="alert" className="error">{error}</p>}
  </div>
}

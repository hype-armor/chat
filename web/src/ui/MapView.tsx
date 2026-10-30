// A map around one point (ADR-0008, ADR-0026). MapLibre and its worker are
// bundled with the app and loaded only when a map is shown; tiles come from
// our own PMTiles file through the core worker (`chat://` protocol), so the
// page makes no map requests of its own.
import { useEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'

type Maplibre = typeof import('maplibre-gl')
let loading: Promise<Maplibre> | undefined

function load(core: CoreClient): Promise<Maplibre> {
  loading ??= (async () => {
    const [maplibre, worker] = await Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
      import('maplibre-gl/dist/maplibre-gl.css'),
    ])
    maplibre.setWorkerUrl(new URL(worker.default, location.href).href)
    maplibre.addProtocol('chat', async (params) => {
      const [z, x, y] = params.url.replace('chat://tiles/', '').split('/').map(Number)
      const data = await core.tile(z, x, y)
      return { data: data ? data.buffer : new ArrayBuffer(0) }
    })
    return maplibre
  })()
  loading.catch(() => {
    loading = undefined
  })
  return loading
}

async function style(core: CoreClient): Promise<import('maplibre-gl').StyleSpecification> {
  const info = await core.mapInfo()
  if (!info.available) {
    // No basemap on this server yet: a plain background, the pin still shows.
    return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e6ecf0' } }] }
  }
  const { layers, namedFlavor } = await import('@protomaps/basemaps')
  return {
    version: 8,
    sources: {
      protomaps: {
        type: 'vector',
        tiles: ['chat://tiles/{z}/{x}/{y}'],
        minzoom: info.minZoom,
        maxzoom: info.maxZoom,
        attribution: '© OpenStreetMap contributors',
      },
    },
    // Label layers need glyph files we don't serve yet: shapes only.
    layers: layers('protomaps', namedFlavor('light'), { lang: 'en' }).filter((l) => l.type !== 'symbol'),
  }
}

export function MapView({
  core,
  latitude,
  longitude,
  interactive = true,
}: {
  core: CoreClient
  latitude: number
  longitude: number
  interactive?: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let map: import('maplibre-gl').Map | undefined
    let cancelled = false
    void (async () => {
      try {
        const [maplibre, mapStyle] = await Promise.all([load(core), style(core)])
        if (cancelled || !container.current) return
        map = new maplibre.Map({
          container: container.current,
          style: mapStyle,
          center: [longitude, latitude],
          zoom: 15,
          interactive,
          attributionControl: { compact: true },
        })
        new maplibre.Marker({ color: '#1f6feb' }).setLngLat([longitude, latitude]).addTo(map)
        map.on('error', (e) => console.warn('map error', e.error))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      map?.remove()
    }
  }, [core, latitude, longitude, interactive])

  if (error) return <p className="small muted">The map can't be shown in this browser.</p>
  return <div ref={container} className="map" data-testid="map" />
}

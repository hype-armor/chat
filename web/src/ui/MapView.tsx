// A map around one point (ADR-0008, ADR-0026). MapLibre and its worker are
// bundled with the app and loaded only when a map is shown; tiles come from
// our own PMTiles file through the core worker (`chat://` protocol), so the
// page makes no map requests of its own.
import { useEffect, useRef, useState } from 'react'
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { CoreClient } from '../core/client'

type Maplibre = typeof import('maplibre-gl')
let loading: Promise<Maplibre> | undefined

function load(core: CoreClient): Promise<Maplibre> {
  loading ??= (async () => {
    const [maplibre] = await Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl.css'),
    ])
    // Keep the URL import static: Vite's dependency optimizer can otherwise
    // resolve the dynamic package import to the worker class, not its URL.
    maplibre.setWorkerUrl(new URL(mapWorkerUrl, location.href).href)
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

export async function mapStyle(core: CoreClient): Promise<import('maplibre-gl').StyleSpecification> {
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
    // MapLibre 6 rasterizes text with local fonts when `glyphs` is absent.
    // Keep text labels, but omit sprite-only symbols and icon images: we do
    // not host a sprite atlas. No glyph, font or sprite URL is configured.
    layers: layers('protomaps', namedFlavor('light'), { lang: 'en' }).flatMap<import('maplibre-gl').LayerSpecification>((layer) => {
      if (layer.type !== 'symbol') return [layer]
      if (!layer.layout?.['text-field']) return []
      const layout = { ...layer.layout }
      delete layout['icon-image']
      return [{ ...layer, layout }]
    }),
  }
}

// A geodesic radius in metres, not a screen-space circle. Unwrap longitudes
// around the pin so an accuracy area at the date line stays a small polygon.
export function accuracyCircle(latitude: number, longitude: number, accuracyM = 0): {
  type: 'FeatureCollection'
  features: { type: 'Feature'; properties: Record<string, never>; geometry: { type: 'Polygon'; coordinates: number[][][] } }[]
} {
  if (!Number.isFinite(accuracyM) || accuracyM <= 0 || accuracyM > 100_000) {
    return { type: 'FeatureCollection', features: [] }
  }
  const radians = Math.PI / 180
  const lat = latitude * radians
  const distance = accuracyM / 6_371_008.8
  const ring: number[][] = []
  for (let i = 0; i < 64; i++) {
    const bearing = 2 * Math.PI * i / 64
    const y = Math.asin(Math.max(-1, Math.min(1,
      Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(bearing),
    )))
    const x = Math.atan2(
      Math.sin(bearing) * Math.sin(distance) * Math.cos(lat),
      Math.cos(distance) - Math.sin(lat) * Math.sin(y),
    )
    ring.push([longitude + x / radians, y / radians])
  }
  ring.push([...ring[0]])
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] }
}

export function MapView({
  core,
  latitude,
  longitude,
  accuracyM = 0,
  interactive = true,
}: {
  core: CoreClient
  latitude: number
  longitude: number
  accuracyM?: number
  interactive?: boolean
}) {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()
  const view = useRef<{ map: import('maplibre-gl').Map; marker: import('maplibre-gl').Marker }>(undefined)
  // The latest point, for a map that finishes loading after it moved.
  const point = useRef<[number, number]>([longitude, latitude])
  point.current = [longitude, latitude]
  const accuracy = useRef(accuracyM)
  accuracy.current = accuracyM

  const updateAccuracy = (map: import('maplibre-gl').Map) => {
    const source = map.getSource<import('maplibre-gl').GeoJSONSource>('location-accuracy')
    source?.setData(accuracyCircle(point.current[1], point.current[0], accuracy.current))
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [maplibre, baseStyle] = await Promise.all([load(core), mapStyle(core)])
        if (cancelled || !container.current) return
        baseStyle.sources['location-accuracy'] = {
          type: 'geojson',
          data: accuracyCircle(point.current[1], point.current[0], accuracy.current),
        }
        const firstLabel = baseStyle.layers.findIndex((layer) => layer.type === 'symbol')
        baseStyle.layers.splice(firstLabel < 0 ? baseStyle.layers.length : firstLabel, 0,
          { id: 'location-accuracy-fill', type: 'fill', source: 'location-accuracy', paint: { 'fill-color': '#1f6feb', 'fill-opacity': 0.16 } },
          { id: 'location-accuracy-outline', type: 'line', source: 'location-accuracy', paint: { 'line-color': '#1f6feb', 'line-width': 1.5 } },
        )
        const map = new maplibre.Map({
          container: container.current,
          style: baseStyle,
          center: point.current,
          zoom: 15,
          interactive,
          attributionControl: { compact: true },
        })
        const marker = new maplibre.Marker({ color: '#1f6feb' }).setLngLat(point.current).addTo(map)
        // A fix can change while MapLibre loads its style and sources.
        map.on('load', () => updateAccuracy(map))
        map.on('error', (e) => console.warn('map error', e.error))
        view.current = { map, marker }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      view.current?.map.remove()
      view.current = undefined
    }
  }, [core, interactive])

  // A live location moves the pin rather than redrawing the map.
  useEffect(() => {
    view.current?.marker.setLngLat([longitude, latitude])
    view.current?.map.easeTo({ center: [longitude, latitude] })
    if (view.current) updateAccuracy(view.current.map)
  }, [latitude, longitude, accuracyM])

  // A late map failure must not move dialog controls during a pointer click.
  if (error) return (
    <div key="unavailable" className="map map-unavailable" data-testid="map">
      <p className="small muted">The map can't be shown in this browser.</p>
    </div>
  )
  return <div key="map" ref={container} className="map" data-testid="map" />
}

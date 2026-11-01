// Map tiles (ADR-0008, ADR-0026, ADR-0033): read here in the core worker,
// from our own origin only, so no map request leaves for a third party and
// networking stays off the UI thread. Two sources:
// - a PMTiles file an operator put on the server (read by HTTP range);
// - otherwise the server's on-demand tiles, which it downloads by area the
//   first time a location there is shared or shown.
import { PMTiles } from 'pmtiles'

/** Where the server (nginx) serves an operator's basemap, if there is one. */
export const BASEMAP_URL = '/tiles/basemap.pmtiles'
/** Areas the server downloads at once are zoom-10 tiles (about 40 km). */
export const AREA_ZOOM = 10
/** How long a map waits for its area to download. */
const AREA_WAIT_MS = 120_000

export type MapInfo = { available: false } | { available: true; minZoom: number; maxZoom: number }

type Source = { kind: 'basemap'; info: MapInfo } | { kind: 'server'; info: MapInfo } | { kind: 'none'; info: MapInfo }

let archive: PMTiles | undefined
const prepared = new Set<string>()
let source: Promise<Source> | undefined

function basemap(): PMTiles {
  archive ??= new PMTiles(new URL(BASEMAP_URL, self.location.href).href)
  return archive
}

async function find(token: string | undefined): Promise<Source> {
  try {
    const h = await basemap().getHeader()
    return { kind: 'basemap', info: { available: true, minZoom: h.minZoom, maxZoom: h.maxZoom } }
  } catch {
    archive = undefined
  }
  if (token) {
    const res = await fetch('/v1/tiles/info', { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined)
    const body = res?.ok ? ((await res.json()) as { on_demand: boolean; max_zoom: number }) : undefined
    if (body?.on_demand) return { kind: 'server', info: { available: true, minZoom: 0, maxZoom: body.max_zoom } }
  }
  return { kind: 'none', info: { available: false } }
}

function current(token: string | undefined): Promise<Source> {
  source ??= find(token).then((s) => {
    // Nothing yet: look again next time (a file may be added later).
    if (s.kind === 'none') source = undefined
    return s
  })
  return source
}

/** Whether maps can be drawn here, and their zoom range. */
export async function mapInfo(token?: string): Promise<MapInfo> {
  return (await current(token)).info
}

/** One vector tile, decompressed, or undefined where the map has none. */
export async function tile(z: number, x: number, y: number, token?: string): Promise<Uint8Array | undefined> {
  const s = await current(token)
  if (s.kind === 'basemap') {
    const data = await basemap().getZxy(z, x, y)
    return data && new Uint8Array(data.data)
  }
  if (s.kind !== 'server' || !token) return undefined
  const until = Date.now() + AREA_WAIT_MS
  for (;;) {
    const res = await fetch(`/v1/tiles/${z}/${x}/${y}`, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 200) return new Uint8Array(await res.arrayBuffer())
    // The area is downloading: wait and ask again.
    if (res.status !== 202 || Date.now() > until) return undefined
    const after = Number(res.headers.get('retry-after') ?? '3')
    await new Promise((r) => setTimeout(r, Math.min(10, Math.max(1, after)) * 1000))
  }
}

/** The tile of zoom `z` holding a point (Web Mercator, as map tiles are cut). */
export function tileAt(latitude: number, longitude: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const lat = (Math.max(-85.0511, Math.min(85.0511, latitude)) * Math.PI) / 180
  const x = Math.floor(((longitude + 180) / 360) * n)
  const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n)
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) }
}

/**
 * Gets a shared location's area onto the server before anyone opens its
 * map: asks for its zoom-10 tile, which starts the area's download. Only
 * with on-demand tiles; never waits.
 */
export function prepareArea(latitude: number, longitude: number, token: string | undefined) {
  const { x, y } = tileAt(latitude, longitude, AREA_ZOOM)
  // Once per area: live locations would otherwise ask on every move.
  if (prepared.has(`${x}/${y}`)) return
  prepared.add(`${x}/${y}`)
  void current(token).then((s) => {
    if (s.kind !== 'server' || !token) return
    void fetch(`/v1/tiles/${AREA_ZOOM}/${x}/${y}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined)
  })
}

/** A location from a message, if its numbers make sense. */
export function safeLocation(
  latitude: number,
  longitude: number,
  accuracyM: number,
  label: string,
): { latitude: number; longitude: number; accuracyM: number; label?: string } | undefined {
  const ok =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    Number.isFinite(accuracyM) &&
    accuracyM >= 0 &&
    accuracyM <= 100_000
  if (!ok) return undefined
  const cleaned = label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100)
  return { latitude, longitude, accuracyM: Math.round(accuracyM), label: cleaned || undefined }
}

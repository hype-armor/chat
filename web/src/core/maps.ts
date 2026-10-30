// Map tiles (ADR-0008, ADR-0026): read from a Protomaps PMTiles file on our
// own origin, by HTTP range, here in the core worker. The page's map asks
// for tiles through the worker, so no map request leaves for a third party
// and networking stays off the UI thread.
import { PMTiles } from 'pmtiles'

/** Where the server (nginx) serves the basemap; absent until an operator adds one. */
export const BASEMAP_URL = '/tiles/basemap.pmtiles'

export type MapInfo = { available: false } | { available: true; minZoom: number; maxZoom: number }

let archive: PMTiles | undefined
let info: Promise<MapInfo> | undefined

function basemap(): PMTiles {
  archive ??= new PMTiles(new URL(BASEMAP_URL, self.location.href).href)
  return archive
}

/** Whether this server has a basemap, and its zoom range. Checked once. */
export function mapInfo(): Promise<MapInfo> {
  info ??= basemap()
    .getHeader()
    .then((h): MapInfo => ({ available: true, minZoom: h.minZoom, maxZoom: h.maxZoom }))
    .catch((): MapInfo => {
      info = undefined // try again next time (the file may be added later)
      archive = undefined
      return { available: false }
    })
  return info
}

/** One vector tile, decompressed, or undefined where the map has none. */
export async function tile(z: number, x: number, y: number): Promise<Uint8Array | undefined> {
  const data = await basemap().getZxy(z, x, y)
  return data && new Uint8Array(data.data)
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

// Approximate locality lookup runs only in the core worker. Unlike a tile
// request or geocoder, the lazy bundled-data request reveals no coordinates.
// Source, attribution and limitations: ./locality-data/README.md.

export type Locality = {
  city: string
  /** US/Canadian postal abbreviation, another region's known name, or absent. */
  region?: string
  countryCode: string
  /** Always approximate: a populated place's region is not a point's region. */
  label: string
  approximate: true
}

/** Rounded coordinates, Unicode city, country code, known region or null. */
export type LocalityRow = readonly [latitudeE4: number, longitudeE4: number, city: string, countryCode: string, region: string | null]

export const LOCALITY_MAX_DISTANCE_M = 25_000
export const LOCALITY_MAX_ACCURACY_M = 5_000
const EARTH_RADIUS_M = 6_371_008.8
// Maximum rounding error from the data's 4-decimal-place coordinates.
const ROUNDING_MARGIN_M = 8
// Nearby cross-border cities are not evidence of the fix's jurisdiction.
const BORDER_AMBIGUITY_MARGIN_M = 5_000
let loading: Promise<readonly LocalityRow[]> | undefined

function validFix(latitude: number, longitude: number, accuracyM: number): boolean {
  return Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
    Number.isFinite(longitude) && Math.abs(longitude) <= 180 &&
    Number.isFinite(accuracyM) && accuracyM >= 0 && accuracyM <= LOCALITY_MAX_ACCURACY_M
}

function distanceM(latitude: number, longitude: number, row: LocalityRow): number {
  const radians = Math.PI / 180
  const lat = row[0] / 10_000
  const lon = row[1] / 10_000
  const a = Math.sin((lat - latitude) * radians / 2) ** 2 +
    Math.cos(latitude * radians) * Math.cos(lat * radians) * Math.sin((lon - longitude) * radians / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))))
}

/** Pure lookup for the worker and focused tests. It never fetches or stores a fix. */
export function nearestLocality(
  latitude: number,
  longitude: number,
  accuracyM: number,
  rows: readonly LocalityRow[],
): Locality | undefined {
  if (!validFix(latitude, longitude, accuracyM)) return undefined
  let nearest: LocalityRow | undefined
  let closest = LOCALITY_MAX_DISTANCE_M - accuracyM - ROUNDING_MARGIN_M
  for (const row of rows) {
    // A latitude-only rejection keeps common lookups cheap without breaking
    // date-line wrapping or convergence of longitude near the poles.
    if (Math.abs(row[0] / 10_000 - latitude) * Math.PI / 180 * EARTH_RADIUS_M > closest) continue
    const distance = distanceM(latitude, longitude, row)
    if (distance <= closest) {
      nearest = row
      closest = distance
    }
  }
  if (!nearest) return undefined
  const ambiguityMargin = Math.max(BORDER_AMBIGUITY_MARGIN_M, 2 * accuracyM + 2 * ROUNDING_MARGIN_M)
  // Look beyond the original 25 km cut-off too: an equally close city just
  // outside that cut-off must not turn an ambiguous border fix into a match.
  for (const row of rows) {
    const differentJurisdiction = row[3] !== nearest[3] || (row[4] && nearest[4] && row[4] !== nearest[4])
    if (!differentJurisdiction) continue
    if (Math.abs(row[0] / 10_000 - latitude) * Math.PI / 180 * EARTH_RADIUS_M > closest + ambiguityMargin) continue
    if (distanceM(latitude, longitude, row) <= closest + ambiguityMargin) return undefined
  }
  const [, , city, countryCode, region] = nearest
  const label = `Near ${[city, region, countryCode === 'US' ? undefined : countryCode].filter(Boolean).join(', ')}`
  return { city, ...(region ? { region } : {}), countryCode, label, approximate: true }
}

/**
 * A nearby populated place, not confirmed municipal membership. The complete
 * reported accuracy radius must fit inside the 25 km distance limit. Fixes
 * worse than 5 km and comparable cross-border candidates produce no result.
 * This point dataset cannot identify nearby water or jurisdiction boundaries.
 * Call this only after explicit consent.
 * A missing offline chunk also produces no result; a later call can retry.
 */
export async function lookupLocality(latitude: number, longitude: number, accuracyM = 0): Promise<Locality | undefined> {
  if (!validFix(latitude, longitude, accuracyM)) return undefined
  try {
    loading ??= import('./locality-data/cities.json').then((module) => module.default as unknown as readonly LocalityRow[])
    return nearestLocality(latitude, longitude, accuracyM, await loading)
  } catch {
    loading = undefined
    return undefined
  }
}

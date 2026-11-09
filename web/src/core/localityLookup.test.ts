import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookupLocality, nearestLocality, type LocalityRow } from './localityLookup'

const rows: LocalityRow[] = [
  [377749, -1224194, 'San Francisco', 'US', 'CA'],
  [-338679, 1512073, 'Sydney', 'AU', 'New South Wales'],
  [0, 1799990, 'Dateline East', 'ZZ', null],
  [899000, 900000, 'Polar Place', 'ZZ', null],
]

afterEach(() => vi.unstubAllGlobals())

describe('private approximate locality lookup', () => {
  it('uses a known US postal abbreviation and always says Near', () => {
    expect(nearestLocality(37.7749, -122.4194, 12, rows)).toEqual({
      city: 'San Francisco', region: 'CA', countryCode: 'US', label: 'Near San Francisco, CA', approximate: true,
    })
  })

  it('keeps a known international region name, without inventing an abbreviation', () => {
    expect(nearestLocality(-33.8679, 151.2073, 25, rows)).toEqual({
      city: 'Sydney', region: 'New South Wales', countryCode: 'AU', label: 'Near Sydney, New South Wales, AU', approximate: true,
    })
  })

  it('does not invent a region when the dataset has none', () => {
    const result = nearestLocality(0, 179.999, 0, rows)
    expect(result).not.toHaveProperty('region')
    expect(result?.label).toBe('Near Dateline East, ZZ')
  })

  it('handles the date line and polar longitude convergence', () => {
    expect(nearestLocality(0, -179.999, 1, rows)?.city).toBe('Dateline East')
    expect(nearestLocality(89.9, 0, 1, rows)?.city).toBe('Polar Place')
  })

  it('chooses the nearest place, not the largest city or first row', () => {
    const places: LocalityRow[] = [[0, 2000, 'Farther', 'US', 'CA'], [0, 100, 'Closer', 'US', 'NV']]
    expect(nearestLocality(0, 0, 10, places)?.label).toBe('Near Closer, NV')
  })

  it('rejects comparable candidates from different known regions or countries', () => {
    const border: LocalityRow[] = [[0, 100, 'West', 'US', 'CA'], [0, 200, 'East', 'US', 'NV']]
    expect(nearestLocality(0, 0, 12, border)).toBeUndefined()
    expect(nearestLocality(0, 0, 12, [[0, 100, 'West', 'AA', null], [0, 200, 'East', 'BB', null]])).toBeUndefined()
    expect(nearestLocality(0, 0, 12, [[0, 100, 'West', 'AA', 'Region'], [0, 200, 'East', 'AA', 'Region']])?.city).toBe('West')
  })

  it('checks ambiguity beyond the initial distance limit and expands it for poor accuracy', () => {
    const border: LocalityRow[] = [[0, 2000, 'West', 'AA', 'West'], [0, 2400, 'East', 'AA', 'East']]
    expect(nearestLocality(0, 0, 0, border)).toBeUndefined()
    const uncertain: LocalityRow[] = [[0, 0, 'West', 'AA', 'West'], [0, 600, 'East', 'AA', 'East']]
    expect(nearestLocality(0, 0, 10, uncertain)?.city).toBe('West')
    expect(nearestLocality(0, 0, 4_000, uncertain)).toBeUndefined()
  })

  it('returns no result for rural or ocean locations outside 25 km', () => {
    expect(nearestLocality(0, 0, 0, rows)).toBeUndefined()
    expect(nearestLocality(0, 0, 0, [])).toBeUndefined()
    expect(nearestLocality(0, 0, 0, [[0, 2300, 'Too Far', 'ZZ', null]])).toBeUndefined()
  })

  it('requires the whole accuracy radius and rounding margin to fit within 25 km', () => {
    const places: LocalityRow[] = [[0, 2000, 'Edge', 'ZZ', null]]
    expect(nearestLocality(0, 0, 1_000, places)?.city).toBe('Edge')
    expect(nearestLocality(0, 0, 4_000, places)).toBeUndefined()
  })

  it.each([
    [NaN, 0, 0], [0, Infinity, 0], [91, 0, 0], [0, -181, 0],
    [0, 0, -1], [0, 0, NaN], [0, 0, 5_001],
  ])('rejects invalid or poor fixes: %s, %s, %s', async (latitude, longitude, accuracyM) => {
    expect(nearestLocality(latitude, longitude, accuracyM, rows)).toBeUndefined()
    expect(await lookupLocality(latitude, longitude, accuracyM)).toBeUndefined()
  })

  it('loads the bundled worldwide data without a fetch or coordinate request', async () => {
    const fetch = vi.fn(() => { throw new Error('No geocoder or map request is allowed') })
    vi.stubGlobal('fetch', fetch)
    expect(await lookupLocality(37.7749, -122.4194, 12)).toMatchObject({ city: 'San Francisco', region: 'CA', countryCode: 'US', approximate: true })
    expect(await lookupLocality(-33.8679, 151.2073, 25)).toMatchObject({ city: 'Sydney', region: 'New South Wales', countryCode: 'AU', approximate: true })
    expect(await lookupLocality(43.6533, -79.3839, 12)).toMatchObject({ city: 'Toronto', region: 'ON', countryCode: 'CA', approximate: true })
    expect(await lookupLocality(45.5088, -73.5878, 12)).toMatchObject({ city: 'Montréal', region: 'QC', countryCode: 'CA', approximate: true })
    expect(await lookupLocality(0, -140, 12)).toBeUndefined()
    // Detroit and Windsor are too close to infer a safe coarse jurisdiction.
    expect(await lookupLocality(42.3314, -83.0458, 12)).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
})

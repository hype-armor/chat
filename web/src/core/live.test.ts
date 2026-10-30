import { describe, expect, it } from 'vitest'
import { HEARTBEAT_MS, MIN_UPDATE_MS, distanceM, plausibleExpiry, updateDue } from './live'

const here = { latitude: 48.8584, longitude: 2.2945 }
const near = { latitude: 48.8585, longitude: 2.2945 } // ~11 m north
const far = { latitude: 48.8594, longitude: 2.2945 } // ~111 m north

describe('live location', () => {
  it('measures distances', () => {
    expect(distanceM(here, here)).toBe(0)
    expect(Math.round(distanceM(here, far))).toBe(111)
  })

  it('sends on movement or heartbeat, never too often', () => {
    expect(updateDue(0, 0, here, far)).toBe(false)
    expect(updateDue(MIN_UPDATE_MS, 0, here, far)).toBe(true)
    expect(updateDue(MIN_UPDATE_MS, 0, here, near)).toBe(false)
    expect(updateDue(HEARTBEAT_MS, 0, here, near)).toBe(true)
    expect(updateDue(MIN_UPDATE_MS, 0, undefined, here)).toBe(true)
  })

  it('accepts session ends up to 8 hours ahead', () => {
    expect(plausibleExpiry(1000 + 15 * 60_000, 1000)).toBe(true)
    expect(plausibleExpiry(1000 + 8 * 3_600_000, 1000)).toBe(true)
    expect(plausibleExpiry(1000 + 9 * 3_600_000, 1000)).toBe(false)
    expect(plausibleExpiry(500, 1000)).toBe(false)
  })
})

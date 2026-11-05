import { describe, expect, it } from 'vitest'
import {
  HEARTBEAT_MS,
  MAX_LIVE_DURATION_MS,
  MIN_UPDATE_MS,
  canResumeUntilStopped,
  distanceM,
  expiryForUpdate,
  plausibleExpiry,
  updateDue,
} from './live'

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
    expect(plausibleExpiry(1000 + MAX_LIVE_DURATION_MS, 1000)).toBe(true)
    expect(plausibleExpiry(1000 + 9 * 3_600_000, 1000)).toBe(false)
    expect(plausibleExpiry(500, 1000)).toBe(false)
  })

  it('renews only until-stopped leases', () => {
    const expiresAt = 1000 + MAX_LIVE_DURATION_MS
    const nextUpdate = 1000 + 60_000
    const renewed = expiryForUpdate(nextUpdate, expiresAt, true)
    expect(renewed).toBe(nextUpdate + MAX_LIVE_DURATION_MS)
    expect(plausibleExpiry(renewed, nextUpdate)).toBe(true)
    expect(expiryForUpdate(nextUpdate, expiresAt, false)).toBe(expiresAt)
  })

  it('reopens an expired until-stopped card only after a fresh lease', () => {
    expect(canResumeUntilStopped(true, false, true, 2000, 1000)).toBe(true)
    expect(canResumeUntilStopped(true, true, true, 2000, 1000)).toBe(false)
    expect(canResumeUntilStopped(true, false, false, 2000, 1000)).toBe(false)
    expect(canResumeUntilStopped(true, false, true, 1000, 1000)).toBe(false)
  })
})

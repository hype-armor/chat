import { describe, expect, it } from 'vitest'
import { safeLocation } from './maps'

describe('received locations', () => {
  it('accepts real coordinates and cleans the label', () => {
    expect(safeLocation(48.8584, 2.2945, 12.4, ' Eiffel\u0000 Tower ')).toEqual({
      latitude: 48.8584,
      longitude: 2.2945,
      accuracyM: 12,
      label: 'Eiffel Tower',
    })
    expect(safeLocation(-90, 180, 0, '')?.label).toBeUndefined()
  })

  it('rejects impossible ones', () => {
    expect(safeLocation(91, 0, 5, '')).toBeUndefined()
    expect(safeLocation(0, -181, 5, '')).toBeUndefined()
    expect(safeLocation(Number.NaN, 0, 5, '')).toBeUndefined()
    expect(safeLocation(0, 0, -1, '')).toBeUndefined()
    expect(safeLocation(0, 0, 1e6, '')).toBeUndefined()
  })
})

describe('tile coordinates', () => {
  it('finds the tile holding a point', async () => {
    const { tileAt } = await import('./maps')
    expect(tileAt(0, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(tileAt(48.8584, 2.2945, 10)).toEqual({ x: 518, y: 352 })
    expect(tileAt(-90, 180, 3)).toEqual({ x: 7, y: 7 })
  })
})

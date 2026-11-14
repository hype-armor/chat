import { describe, expect, it } from 'vitest'
import type { CoreClient } from '../core/client'
import { accuracyCircle, mapStyle } from './MapView'

function core(available: boolean): CoreClient {
  return { mapInfo: async () => ({ available, minZoom: 0, maxZoom: 15 }) } as unknown as CoreClient
}

function distance(latitude: number, longitude: number, point: number[]): number {
  const radians = Math.PI / 180
  const dy = (point[1] - latitude) * radians
  const dx = (point[0] - longitude) * radians
  const a = Math.sin(dy / 2) ** 2 + Math.cos(latitude * radians) * Math.cos(point[1] * radians) * Math.sin(dx / 2) ** 2
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

describe('map label style', () => {
  it('keeps local-font text labels without external glyph, font, or sprite requests', async () => {
    const style = await mapStyle(core(true))
    expect(style.glyphs).toBeUndefined()
    expect(style.sprite).toBeUndefined()
    expect(style['font-faces']).toBeUndefined()
    expect(style.sources.protomaps).toMatchObject({ type: 'vector', tiles: ['chat://tiles/{z}/{x}/{y}'] })
    const labels = style.layers.filter((layer) => layer.type === 'symbol')
    expect(labels.length).toBeGreaterThan(5)
    for (const label of labels) {
      expect(label.layout?.['text-field']).toBeTruthy()
      expect(label.layout?.['icon-image']).toBeUndefined()
    }
  })

  it('keeps the plain background when the server has no map tiles', async () => {
    const style = await mapStyle(core(false))
    expect(style.sources).toEqual({})
    expect(style.layers).toEqual([expect.objectContaining({ type: 'background' })])
  })
})

describe('location accuracy area', () => {
  it.each([
    [0, 0, 12],
    [48.8584, 2.2945, 500],
    [80, 12, 100_000],
    [-80, -30, 5_000],
    [0, 179.999, 1_000],
    [0, -179.999, 1_000],
  ])('draws a closed, metre-based area at %s, %s with radius %s', (latitude, longitude, radius) => {
    const ring = accuracyCircle(latitude, longitude, radius).features[0].geometry.coordinates[0]
    expect(ring).toHaveLength(65)
    expect(ring[0]).toEqual(ring[64])
    for (const point of ring) {
      expect(distance(latitude, longitude, point)).toBeCloseTo(radius, 5)
      expect(Math.abs(point[0] - longitude)).toBeLessThan(6)
    }
  })

  it.each([0, -1, 100_001, Infinity, NaN])('omits an invalid or zero radius of %s', (radius) => {
    expect(accuracyCircle(48, 2, radius).features).toEqual([])
  })

  it('changes both the centre and the radius for the latest live fix', () => {
    const first = accuracyCircle(48.8584, 2.2945, 12)
    const second = accuracyCircle(48.8584, 2.3027, 8)
    expect(second).not.toEqual(first)
    for (const point of second.features[0].geometry.coordinates[0]) {
      expect(distance(48.8584, 2.3027, point)).toBeCloseTo(8, 5)
    }
  })
})

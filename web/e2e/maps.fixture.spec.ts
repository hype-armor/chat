import { expect as baseExpect, test } from './fixtures'
import type { Map, GeoJSONSourceSpecification } from 'maplibre-gl'

const expect = baseExpect.configure({ timeout: 20_000 })
test.setTimeout(60_000)
test.use({ permissions: ['geolocation'], geolocation: { latitude: 1, longitude: 1, accuracy: 75 } })

async function requireWebGL(page: import('@playwright/test').Page) {
  const map = page.getByTestId('live-location').getByTestId('map')
  const fallback = map.getByText("The map can't be shown in this browser.", { exact: true })
  await expect(map.locator('.maplibregl-canvas').or(fallback)).toBeVisible()
  if (await fallback.isVisible()) {
    await expect(map).toHaveCSS('height', '260px')
    test.skip(true, 'WebGL is unavailable in this browser; the stable-size fallback is verified')
  }
}

declare global {
  interface Window {
    mapFixture: { maps: Map[]; restore(): void }
    updateMapPoint(point: { latitude: number; longitude: number; accuracyM: number }): void
  }
}

async function area(page: import('@playwright/test').Page, index: number) {
  return page.evaluate((i) => {
    const map = window.mapFixture?.maps[i]
    if (!map?.isStyleLoaded()) return undefined
    const source = map.getStyle().sources['location-accuracy'] as GeoJSONSourceSpecification
    return source.data
  }, index)
}

test('local fonts render labels; static, preview, and live maps show metre-based accuracy', async ({ page, baseURL }) => {
  const foreign: string[] = []
  const fontRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== new URL(baseURL!).origin) foreign.push(request.url())
    if (/\.(pbf|woff2?|ttf)(?:\?|$)|glyphs|sprites/.test(request.url())) fontRequests.push(request.url())
  })
  await page.goto('/e2e/maps-fixture.html')
  try {
    await requireWebGL(page)
    await expect.poll(() => page.evaluate(() => {
      const map = window.mapFixture?.maps[0]
      return map?.isStyleLoaded() && map.queryRenderedFeatures({ layers: ['places_locality'] })
        .some((feature) => feature.properties.name === 'Synthetic City')
    })).toBe(true)
    await expect.poll(() => area(page, 0)).toMatchObject({ type: 'FeatureCollection', features: [{ geometry: { type: 'Polygon' } }] })
    const first = await area(page, 0)

    // An accuracy-only update must resize the area without rebuilding the map.
    await page.evaluate(() => window.updateMapPoint({ latitude: 1, longitude: 1, accuracyM: 300 }))
    await expect.poll(() => area(page, 0)).not.toEqual(first)
    const resized = await area(page, 0)
    await page.evaluate(() => window.updateMapPoint({ latitude: 1.001, longitude: 1.002, accuracyM: 50 }))
    await expect.poll(() => area(page, 0)).not.toEqual(resized)
    await expect.poll(() => page.evaluate(() => window.mapFixture.maps[0].getCenter().lng)).toBeCloseTo(1.002, 4)
    expect(await page.evaluate(() => window.mapFixture.maps.length)).toBe(1)

    // Static received location uses the same accuracy overlay.
    await page.getByTestId('location').getByRole('button', { name: 'Show map' }).click()
    await expect.poll(() => area(page, 1)).toEqual(first)
    await page.getByRole('button', { name: 'Preview location' }).click()
    const preview = page.getByRole('dialog', { name: 'Share this location?' })
    await expect(preview).toBeVisible()
    await expect.poll(() => area(page, 2)).toMatchObject({ type: 'FeatureCollection', features: [{ geometry: { type: 'Polygon' } }] })
    expect(await area(page, 2)).not.toEqual(first)
    expect(foreign).toEqual([])
    expect(fontRequests).toEqual([])
  } finally {
    await page.evaluate(() => window.mapFixture?.restore())
  }
})

test('accuracy remains available without a basemap and disappears for a zero radius', async ({ page }) => {
  await page.goto('/e2e/maps-fixture.html?no-tiles')
  try {
    await requireWebGL(page)
    await expect.poll(() => area(page, 0)).toMatchObject({ features: [{ geometry: { type: 'Polygon' } }] })
    await page.evaluate(() => window.updateMapPoint({ latitude: 1, longitude: 1, accuracyM: 0 }))
    await expect.poll(() => area(page, 0)).toEqual({ type: 'FeatureCollection', features: [] })
    expect(await page.evaluate(() => window.mapFixture.maps[0].getLayer('location-accuracy-fill')?.type)).toBe('fill')
  } finally {
    await page.evaluate(() => window.mapFixture?.restore())
  }
})

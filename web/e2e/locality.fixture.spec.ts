import { expect, test, type Page } from './fixtures'
import { openFixture } from './interaction-fixture-support'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; consent and header fixtures only, no delivery claim')

type GeoState = { watches: number; gets: number; clears: number[]; fix(id?: number, old?: boolean): void; fail(id?: number): void; visible(value: boolean): void }
type Activity = { updates: number; unavailable: number; settings: boolean[] }

async function installGeo(page: Page) {
  await page.addInitScript(() => {
    let visible = true
    let watches = 0
    let gets = 0
    const clears: number[] = []
    const callbacks = new Map<number, { success: PositionCallback; failure: PositionErrorCallback | null | undefined }>()
    const position = (old = false) => ({ timestamp: Date.now() - (old ? 10 * 60_000 : 0), coords: { latitude: 30.2672, longitude: -97.7431, accuracy: 12 } }) as GeolocationPosition
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' })
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      watchPosition(success: PositionCallback, failure?: PositionErrorCallback | null) {
        callbacks.set(++watches, { success, failure })
        return watches
      },
      getCurrentPosition(success: PositionCallback) { gets++; success(position()) },
      clearWatch(id: number) { clears.push(id) },
    } })
    Object.assign(window, { localityGeo: {
      get watches() { return watches }, get gets() { return gets }, clears,
      fix(id = watches, old = false) { callbacks.get(id)?.success(position(old)) },
      fail(id = watches) { callbacks.get(id)?.failure?.({ code: 1, message: 'Synthetic permission denial' } as GeolocationPositionError) },
      visible(value: boolean) { visible = value; document.dispatchEvent(new Event('visibilitychange')) },
    } })
  })
}
const activity = (page: Page) => page.evaluate(() => (window as unknown as { localityFixture: { activity: Activity } }).localityFixture.activity)
const geoCounts = (page: Page) => page.evaluate(() => {
  const geo = (window as unknown as { localityGeo: GeoState }).localityGeo
  return { watches: geo.watches, gets: geo.gets, clears: [...geo.clears] }
})
async function geoAction(page: Page, action: 'fix' | 'fail' | 'visible', value?: boolean | number, old?: boolean) {
  await page.evaluate(({ action, value, old }) => {
    const geo = (window as unknown as { localityGeo: GeoState }).localityGeo
    if (action === 'visible') geo.visible(value as boolean)
    else if (action === 'fix') geo.fix(value as number | undefined, old)
    else geo.fail(value as number | undefined)
  }, { action, value, old })
}
async function openConsent(page: Page) {
  await installGeo(page)
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto('/e2e/locality-fixture.html')
  await expect(page.getByRole('checkbox', { name: 'Automatic current location', exact: true })).not.toBeChecked()
}

test('automatic locality needs explicit consent and StrictMode does not duplicate the watch', async ({ page }) => {
  await openConsent(page)
  expect(await geoCounts(page)).toEqual({ watches: 0, gets: 0, clears: [] })
  await expect(page.getByText(/Off by default/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'GeoNames', exact: true })).toHaveAttribute('href', 'https://www.geonames.org/')
  await expect(page.getByRole('link', { name: 'CC BY 4.0', exact: true })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/')
  const toggle = page.getByRole('checkbox', { name: 'Automatic current location', exact: true })
  await toggle.check()
  await expect.poll(async () => (await geoCounts(page)).watches).toBe(1)
  await geoAction(page, 'fix')
  await expect(page.getByRole('status')).toHaveText('Sharing: Near Austin, TX')
  expect((await activity(page)).updates).toBe(1)
  await toggle.uncheck()
  await expect.poll(async () => (await geoCounts(page)).clears).toEqual([1])
  await geoAction(page, 'fix', 1)
  expect((await activity(page)).updates).toBe(1)
  expect((await activity(page)).settings).toEqual([true, false])
})

test('foreground watches pause, ignore late fixes, and refresh stationary positions', async ({ page }) => {
  await page.clock.install()
  await openConsent(page)
  await page.getByRole('checkbox', { name: 'Automatic current location', exact: true }).check()
  await expect.poll(async () => (await geoCounts(page)).watches).toBe(1)
  await geoAction(page, 'visible', false)
  expect((await geoCounts(page)).clears).toEqual([1])
  await geoAction(page, 'fix', 1)
  expect((await activity(page)).updates).toBe(0)
  await page.clock.fastForward(15 * 60_000)
  expect((await geoCounts(page)).gets).toBe(0)
  await geoAction(page, 'visible', true)
  await expect.poll(async () => (await geoCounts(page)).watches).toBe(2)
  await geoAction(page, 'fix', 1)
  expect((await activity(page)).updates).toBe(0)
  await geoAction(page, 'fix', 2)
  expect((await activity(page)).updates).toBe(1)
  await page.clock.fastForward(15 * 60_000)
  expect((await geoCounts(page)).gets).toBe(1)
  expect((await activity(page)).updates).toBe(2)
})

test('permission failure stays latched through hide/show until explicit retry', async ({ page }) => {
  await openConsent(page)
  const toggle = page.getByRole('checkbox', { name: 'Automatic current location', exact: true })
  await toggle.check()
  await expect.poll(async () => (await geoCounts(page)).watches).toBe(1)
  await geoAction(page, 'fail')
  await expect(page.getByRole('status')).toContainText('Current city unavailable')
  await geoAction(page, 'visible', false)
  await geoAction(page, 'visible', true)
  expect((await geoCounts(page)).watches).toBe(1)
  await geoAction(page, 'fix', 1)
  expect((await activity(page)).updates).toBe(0)
  expect((await activity(page)).unavailable).toBe(1)
  await toggle.uncheck()
  await toggle.check()
  await expect.poll(async () => (await geoCounts(page)).watches).toBe(2)
  await geoAction(page, 'fix', 2)
  await expect(page.getByRole('status')).toHaveText('Sharing: Near Austin, TX')
})

test('an old geolocation fix is not forwarded for locality publication', async ({ page }) => {
  await openConsent(page)
  await page.getByRole('checkbox', { name: 'Automatic current location', exact: true }).check()
  await expect.poll(async () => (await geoCounts(page)).watches).toBe(1)
  await geoAction(page, 'fix', 1, true)
  await expect(page.getByRole('status')).toContainText('Current city unavailable')
  expect((await activity(page)).updates).toBe(0)
})

for (const width of [320, 390, 1280]) {
  test(`coarse locality appears only beside a direct recipient name (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await openFixture(page)
    const setLocality = (mode: number) => page.evaluate((mode) => (window as unknown as {
      interactionFixture: { peerLocality(mode: number): void }
    }).interactionFixture.peerLocality(mode), mode)
    await setLocality(1)
    const header = page.locator('.conversation-bar')
    await expect(header.getByText('Near Austin, TX', { exact: true })).toBeVisible()
    await expect(header.getByText('Near Austin, TX', { exact: true })).toHaveAttribute('title', /Approximate nearby city/)
    await expect(page.getByRole('navigation', { name: 'Conversations', exact: true, includeHidden: true })).not.toContainText('Austin')
    await expect(header.getByRole('heading', { name: 'Bob', exact: true })).toBeVisible()
    expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await setLocality(2)
    await expect(header.getByText('Near Paris, FR', { exact: true })).toBeVisible()
    await setLocality(0)
    await expect(header.locator('.issue132-recipient-locality')).toHaveCount(0)
  })
}

test('group headers do not show a locality supplied by a view fixture', async ({ page }) => {
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto('/e2e/interactions-fixture.html?group=1')
  await page.getByRole('navigation', { name: 'Conversations', exact: true }).getByRole('button', { name: /Bob/ }).click()
  await page.evaluate(() => (window as unknown as { interactionFixture: { peerLocality(): void } }).interactionFixture.peerLocality())
  await expect(page.locator('.conversation-bar .issue132-recipient-locality')).toHaveCount(0)
  await expect(page.getByTestId('fixture-error')).toHaveCount(0)
})

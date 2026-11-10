import { expect, test, type Page } from './fixtures'
import { fixtureAction, openFixture } from './interaction-fixture-support'
import { messages } from './support'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; per-contact UI contracts only, not lookup or encrypted delivery')

type GeoState = { watches: number; gets: number; clears: number[]; fix(): void; visible(value: boolean): void; restore(): void }
type HeaderViewportWindow = Window & { localityViewport?: { resize(height: number, offsetTop: number): void; restore(): void } }
type Activity = {
  locationSends: { conversationId: string; location: { latitude: number; longitude: number; accuracyM: number } }[]
  liveStarts: { conversationId: string; durationMs: number | null }[]
  liveActivity: { updates: number; stops: string[] }
}

async function installGeo(page: Page) {
  await page.addInitScript(() => {
    const originalGeo = Object.getOwnPropertyDescriptor(navigator, 'geolocation')
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    let visible = true
    let watches = 0
    let gets = 0
    const clears: number[] = []
    const callbacks = new Map<number, PositionCallback>()
    const position = () => ({ timestamp: Date.now(), coords: { latitude: 30.2672, longitude: -97.7431, accuracy: 12 } }) as GeolocationPosition
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' })
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      watchPosition(success: PositionCallback) { callbacks.set(++watches, success); return watches },
      getCurrentPosition(success: PositionCallback) { gets++; success(position()) },
      clearWatch(id: number) { clears.push(id); callbacks.delete(id) },
    } })
    Object.assign(window, { localityGeo: {
      get watches() { return watches }, get gets() { return gets }, clears,
      fix() { callbacks.get(watches)?.(position()) },
      visible(value: boolean) { visible = value; document.dispatchEvent(new Event('visibilitychange')) },
      restore() {
        if (originalGeo) Object.defineProperty(navigator, 'geolocation', originalGeo)
        else Reflect.deleteProperty(navigator, 'geolocation')
        if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
        else Reflect.deleteProperty(document, 'visibilityState')
      },
    } })
  })
}
const activity = (page: Page) => page.evaluate(() => {
  const fixture = (window as unknown as { interactionFixture: Activity }).interactionFixture
  return { locationSends: fixture.locationSends, liveStarts: fixture.liveStarts, liveActivity: fixture.liveActivity }
})
const geoCounts = (page: Page) => page.evaluate(() => {
  const geo = (window as unknown as { localityGeo: GeoState }).localityGeo
  return { watches: geo.watches, gets: geo.gets, clears: [...geo.clears] }
})
async function visibility(page: Page, visible: boolean) {
  await page.evaluate((value) => (window as unknown as { localityGeo: GeoState }).localityGeo.visible(value), visible)
}
async function previewLocation(page: Page) {
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Location', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Share this location?', exact: true })
  await expect(preview).toBeVisible()
  return preview
}
async function setLocality(page: Page, mode: number, conversationId = 'chat') {
  await page.evaluate(({ mode, conversationId }) => (window as unknown as {
    interactionFixture: { peerLocality(mode: number, conversationId: string): void }
  }).interactionFixture.peerLocality(mode, conversationId), { mode, conversationId })
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => (window as unknown as { localityGeo?: GeoState }).localityGeo?.restore())
})

test('navigation, settings and foreground changes never start automatic location sharing', async ({ page }) => {
  await page.clock.install()
  await installGeo(page)
  await openFixture(page)
  await fixtureAction(page, 'addChat')
  await page.getByRole('button', { name: /Other chat/ }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('navigation', { name: 'Settings', exact: true })
  await expect(settings.getByText('Automatic current location', { exact: true })).toHaveCount(0)
  await expect(settings.getByRole('checkbox', { name: /automatic.*location|city.*state/i })).toHaveCount(0)
  await expect(settings.getByText(/Off by default|Updates expire within 1 hour/)).toHaveCount(0)
  const attribution = settings.getByRole('link', { name: 'GeoNames', exact: true })
  await expect(attribution).toBeHidden()
  await settings.locator('summary').filter({ hasText: 'Location data' }).click()
  await expect(attribution).toHaveAttribute('href', 'https://www.geonames.org/')
  await expect(settings.getByRole('link', { name: 'CC BY 4.0', exact: true })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/')
  await visibility(page, false)
  await page.clock.fastForward(30 * 60_000)
  await visibility(page, true)
  expect(await geoCounts(page)).toEqual({ watches: 0, gets: 0, clears: [] })
  expect(await activity(page)).toMatchObject({ locationSends: [], liveStarts: [] })
  await expect(page.getByTestId('fixture-error')).toHaveCount(0)
})

test('preview and one-shot send require the contact action and do not start a watcher', async ({ page }) => {
  await installGeo(page)
  await openFixture(page)
  await fixtureAction(page, 'addChat')
  expect(await geoCounts(page)).toEqual({ watches: 0, gets: 0, clears: [] })
  const first = await previewLocation(page)
  await expect(first).toContainText('Shared only in this conversation.')
  await expect(first).toContainText('The last point expires after 8 hours without an update.')
  await expect(first.getByRole('link', { name: 'GeoNames', exact: true })).toHaveCount(0)
  expect(await activity(page)).toMatchObject({ locationSends: [], liveStarts: [] })
  await first.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await geoCounts(page)).toEqual({ watches: 0, gets: 1, clears: [] })
  await page.getByRole('button', { name: /Other chat/ }).click()
  const second = await previewLocation(page)
  await second.getByRole('button', { name: 'Send location', exact: true }).click()
  await expect(second).toBeHidden()
  expect((await activity(page)).locationSends).toEqual([{
    conversationId: 'other', location: { latitude: 30.2672, longitude: -97.7431, accuracyM: 12 },
  }])
  expect((await activity(page)).liveStarts).toEqual([])
  expect(await geoCounts(page)).toEqual({ watches: 0, gets: 2, clears: [] })
  await expect(page.locator('.issue132-recipient-locality')).toHaveCount(0)
})

test('live sharing watches only an explicitly started contact share and retains its stop controls', async ({ page }) => {
  await installGeo(page)
  await openFixture(page)
  await fixtureAction(page, 'addChat')
  const preview = await previewLocation(page)
  expect((await geoCounts(page)).watches).toBe(0)
  expect((await activity(page)).liveStarts).toEqual([])
  await preview.getByRole('button', { name: '15 min', exact: true }).click()
  expect((await activity(page)).liveStarts).toEqual([{
    conversationId: 'chat', durationMs: 15 * 60_000,
    location: { latitude: 30.2672, longitude: -97.7431, accuracyM: 12 },
  }])
  // Only the fake worker's active-share view can authorize the existing watcher.
  await fixtureAction(page, 'activeLiveShare')
  await expect.poll(async () => (await geoCounts(page)).watches).toBe(1)
  await page.evaluate(() => (window as unknown as { localityGeo: GeoState }).localityGeo.fix())
  await expect.poll(async () => (await activity(page)).liveActivity.updates).toBe(1)
  const card = page.getByTestId('live-location')
  await expect(card.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible()
  await expect(card).not.toContainText('temporary grants')
  await expect(page.locator('.sidebar .live-dot')).toHaveCount(1)
  await expect(page.locator('.live-banner, .live-sharing-indicators')).toHaveCount(0)
  await page.getByRole('button', { name: /Other chat/ }).click()
  await expect(page.getByTestId('live-location')).toHaveCount(0)
  await expect(page.locator('.issue132-recipient-locality')).toHaveCount(0)
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Stop sharing location', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Bob/ }).click()
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Stop sharing location', exact: true }).click()
  await expect.poll(async () => (await geoCounts(page)).clears).toEqual([1])
  expect((await activity(page)).liveActivity.stops).toEqual(['chat'])
  await expect(page.locator('.sidebar .live-dot')).toHaveCount(0)
})

for (const width of [390, 1024]) {
  test(`contact name/avatar opens only authorized live-location details (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await installGeo(page)
    await openFixture(page)
    await fixtureAction(page, 'addChat')
    await page.evaluate(() => (window as unknown as { interactionFixture: { contactLocationMessages(): void } }).interactionFixture.contactLocationMessages())
    await expect(messages(page)).toHaveCount(6)
    const name = page.getByRole('button', { name: 'Contact details', exact: true })
    await name.locator(width === 390 ? '.conversation-name' : '.avatar').click()
    const details = page.getByRole('dialog', { name: 'Conversation details', exact: true })
    await expect(details).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('.sidebar')).toHaveAttribute('inert', '')
    await expect(page.locator('.conversation')).toHaveAttribute('inert', '')
    await expect(page.getByRole('menu', { name: 'Conversation menu', exact: true })).toHaveCount(0)
    const location = details.getByRole('region', { name: 'Contact live location', exact: true })
    await expect(location.getByTestId('live-location')).toHaveCount(1)
    await expect(location).toContainText('30.26720, -97.74310')
    await expect(location.getByRole('button', { name: 'Stop sharing', exact: true })).toHaveCount(0)
    // Prior details show live shares only. Do not add a static-location fallback.
    await expect(details).not.toContainText('40.00000, -75.00000')
    const map = location.getByTestId('map')
    const before = (await map.boundingBox())!
    expect(before.height).toBeCloseTo(224, 2)
    await page.evaluate(() => (window as unknown as { interactionFixture: { failMap(): void } }).interactionFixture.failMap())
    await expect(map).toContainText("The map can't be shown in this browser.")
    const after = (await map.boundingBox())!
    for (const dimension of ['x', 'y', 'width', 'height'] as const) expect(after[dimension]).toBeCloseTo(before[dimension], 2)
    await page.keyboard.press('Escape')
    await expect(details).toBeHidden()
    await expect(name).toBeFocused()
    await expect(page.locator('.sidebar')).not.toHaveAttribute('inert')
    await expect(page.locator('.issue132-recipient-locality')).toHaveCount(0)
    expect(await geoCounts(page)).toEqual({ watches: 0, gets: 0, clears: [] })
    if (width <= 640) await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
    await page.getByRole('button', { name: /Other chat/ }).click()
    await page.getByRole('button', { name: 'Contact details', exact: true }).click()
    await expect(details.getByRole('region', { name: 'Contact live location', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    expect(await geoCounts(page)).toEqual({ watches: 0, gets: 0, clears: [] })
  })
}

for (const width of [320, 390, 393, 1280]) {
  test(`locality stays below the contact name with usable header actions (${width}px)`, async ({ page }) => {
    const title = width === 393 ? 'Echo (test bot)' : 'Bob Montgomery with a very long contact name'
    await page.setViewportSize({ width, height: 844 })
    await page.addInitScript(({ width }) => {
      const descriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport')
      const viewport = Object.assign(new EventTarget(), { width, height: 844, offsetTop: 0, scale: 1 })
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
      ;(window as HeaderViewportWindow).localityViewport = {
        resize(height, offsetTop) {
          Object.assign(viewport, { height, offsetTop })
          viewport.dispatchEvent(new Event('resize'))
          viewport.dispatchEvent(new Event('scroll'))
        },
        restore() {
          if (descriptor) Object.defineProperty(window, 'visualViewport', descriptor)
          else Reflect.deleteProperty(window, 'visualViewport')
          delete (window as HeaderViewportWindow).localityViewport
        },
      }
    }, { width })
    try {
      await installGeo(page)
      await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
      await page.goto(`/e2e/interactions-fixture.html?${new URLSearchParams({ title })}`)
      await page.getByRole('navigation', { name: 'Conversations', exact: true }).getByRole('button', { name: width === 393 ? /Echo \(test bot\)/ : /Bob Montgomery/ }).click()
      await setLocality(page, 1)
      const header = page.locator('.conversation-bar')
      const name = header.getByRole('button', { name: 'Contact details', exact: true })
      const trigger = header.getByRole('button', { name: 'Conversation menu', exact: true })
      for (const { height, offsetTop } of [{ height: 844, offsetTop: 0 }, { height: 320, offsetTop: 0 }, { height: 240, offsetTop: 140 }]) {
        await page.evaluate(({ height, offsetTop }) => (window as HeaderViewportWindow).localityViewport!.resize(height, offsetTop), { height, offsetTop })
        await expect(page.locator('html')).toHaveCSS('--app-height', `${height}px`)
        await expect(page.locator('html')).toHaveCSS('--app-top', `${offsetTop}px`)
        await expect(name).toHaveAccessibleDescription(`${title} Near Austin, TX`)
        await expect(trigger).toHaveAccessibleDescription(`${title} Near Austin, TX`)
        await expect.poll(() => header.evaluate((header) => {
          const heading = header.querySelector<HTMLElement>('.conversation-name')!
          const locality = header.querySelector<HTMLElement>('.issue132-recipient-locality')!
          const title = header.querySelector('.issue132-recipient-details')!.getBoundingClientRect()
          const actions = header.querySelector('.header-actions')!.getBoundingClientRect()
          const bounds = header.getBoundingClientRect()
          const nameBox = heading.getBoundingClientRect()
          const localityBox = locality.getBoundingClientRect()
          return {
            stacked: localityBox.top >= nameBox.bottom - 0.5,
            aligned: Math.abs(localityBox.left - nameBox.left) <= 1,
            independentRows: Math.abs(localityBox.width - nameBox.width) <= 1,
            localityReadable: locality.scrollWidth <= locality.clientWidth,
            nameHasWidth: nameBox.width > 0,
            separateActions: title.right <= actions.left + 0.5,
            actionsInside: actions.left >= bounds.left && actions.right <= bounds.right + 0.5 && actions.top >= bounds.top && actions.bottom <= bounds.bottom + 0.5,
            noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          }
        })).toEqual({ stacked: true, aligned: true, independentRows: true, localityReadable: true, nameHasWidth: true, separateActions: true, actionsInside: true, noHorizontalOverflow: true })
        if (width === 393 && height === 844 && test.info().project.name === 'chromium') await page.screenshot({ path: test.info().outputPath('stacked-locality-393.png') })
        if (width === 393) {
          await expect.poll(() => name.locator('.conversation-name').evaluate((el) => el.scrollWidth - el.clientWidth), {
            message: 'Echo (test bot) must fit without ellipsis at the screenshot width',
          }).toBeLessThanOrEqual(0)
          // Integer scroll widths can hide fractional overflow that still draws an ellipsis.
          await expect.poll(() => name.locator('.conversation-name').evaluate((el) => {
            const range = document.createRange()
            range.selectNodeContents(el)
            return range.getBoundingClientRect().width - el.getBoundingClientRect().width
          }), { message: 'The complete Echo name must fit its fractional layout box' }).toBeLessThanOrEqual(0)
        }
        await trigger.focus()
        await trigger.press('ArrowDown')
        const menu = page.getByRole('menu', { name: 'Conversation menu', exact: true })
        for (const label of ['Voice call', 'Video call']) {
          const inline = header.getByRole('button', { name: label, exact: true })
          const action = menu.getByRole('menuitem', { name: label, exact: true })
          await expect.poll(async () => (await inline.count()) + (await action.count())).toBe(1)
          if (await inline.count()) await expect(inline).toBeVisible()
          else await expect(action).toBeVisible()
          if (width === 320) await expect(action).toHaveCount(1)
          if (width === 1280) await expect(inline).toHaveCount(1)
        }
        await menu.getByRole('menuitemcheckbox', { name: 'Typing indicators', exact: true }).press('End')
        const last = menu.getByRole('menuitem', { name: 'Block', exact: true })
        await expect(last).toBeFocused()
        await expect.poll(async () => {
          const popup = (await menu.boundingBox())!
          const focused = (await last.boundingBox())!
          return popup.y >= offsetTop && popup.y + popup.height <= offsetTop + height && focused.y >= popup.y && focused.y + focused.height <= popup.y + popup.height
        }).toBe(true)
        await page.keyboard.press('Escape')
        await expect(menu).toHaveCount(0)
        await expect(trigger).toBeFocused()
      }
      await page.evaluate(() => (window as HeaderViewportWindow).localityViewport!.resize(844, 0))
      await expect(page.locator('html')).toHaveCSS('--app-top', '0px')
      for (const target of ['.conversation-name', '.avatar']) {
        await name.locator(target).click()
        const details = page.getByRole('dialog', { name: 'Conversation details', exact: true })
          .or(page.getByRole('complementary', { name: 'Conversation details', exact: true }))
        await expect(details).toBeVisible()
        await expect(page.getByRole('menu', { name: 'Conversation menu', exact: true })).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(details).toBeHidden()
        await expect(name).toBeFocused()
        await expect(trigger).toHaveAccessibleDescription(`${title} Near Austin, TX`)
      }
      expect(await geoCounts(page)).toEqual({ watches: 0, gets: 0, clears: [] })
      await expect(page.getByTestId('fixture-error')).toHaveCount(0)
    } finally {
      await page.evaluate(() => (window as HeaderViewportWindow).localityViewport?.restore())
    }
  })

  test(`worker-supplied approximate locality stays in its direct conversation (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await installGeo(page)
    await openFixture(page)
    await setLocality(page, 1)
    await fixtureAction(page, 'addChat')
    const header = page.locator('.conversation-bar')
    await expect(header.getByText('Near Austin, TX', { exact: true })).toBeVisible()
    await expect(header.getByText('Near Austin, TX', { exact: true })).toHaveAttribute('title', /Approximate nearby city/)
    await expect(page.getByRole('navigation', { name: 'Conversations', exact: true, includeHidden: true })).not.toContainText('Austin')
    await expect(header.getByRole('heading', { name: 'Bob', exact: true })).toBeVisible()
    expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    if (width <= 640) await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
    await page.getByRole('button', { name: /Other chat/ }).click()
    await expect(header.locator('.issue132-recipient-locality')).toHaveCount(0)
    await setLocality(page, 2, 'other')
    await expect(header.getByText('Near Paris, FR', { exact: true })).toBeVisible()
    if (width <= 640) await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
    await page.getByRole('button', { name: /Bob/ }).click()
    await expect(header.getByText('Near Austin, TX', { exact: true })).toBeVisible()
    await setLocality(page, 0)
    await expect(header.locator('.issue132-recipient-locality')).toHaveCount(0)
    expect(await geoCounts(page)).toEqual({ watches: 0, gets: 0, clears: [] })
  })
}

test('group headers do not show a locality supplied by a view fixture', async ({ page }) => {
  await installGeo(page)
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto('/e2e/interactions-fixture.html?group=1')
  await page.getByRole('navigation', { name: 'Conversations', exact: true }).getByRole('button', { name: /Bob/ }).click()
  await setLocality(page, 1)
  await expect(page.locator('.conversation-bar .issue132-recipient-locality')).toHaveCount(0)
  expect(await geoCounts(page)).toEqual({ watches: 0, gets: 0, clears: [] })
  await expect(page.getByTestId('fixture-error')).toHaveCount(0)
})

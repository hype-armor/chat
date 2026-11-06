import { type Browser, expect, test } from '@playwright/test'
import { messages, openChat, openSettings, randomUsername, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

const EIFFEL = { latitude: 48.8584, longitude: 2.2945, accuracy: 12 }

/** Signs up in a context that may read `EIFFEL` as its position. */
async function signUp(browser: Browser, name: string, username: string, origins: Set<string>, violations: string[]) {
  const context = await browser.newContext({ geolocation: EIFFEL, permissions: ['geolocation'] })
  const page = await context.newPage()
  // CSP and Trusted Types violations show up as console errors.
  page.on('console', (m) => m.type() === 'error' && /Content Security Policy|TrustedScriptURL|Trusted Type/.test(m.text()) && violations.push(m.text()))
  // Every request the page or its workers make, to prove none leave our origin.
  context.on('request', (r) => origins.add(new URL(r.url()).origin))
  await page.goto('/')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Sign up' }).click()
  await expect(page.getByRole('status')).toHaveText('Connected')
  return page
}

test('a location shared once arrives encrypted and maps without third parties (FR-LOC-1/4/5)', async ({
  browser,
  browserName,
  baseURL,
}) => {
  const origins = new Set<string>()
  const violations: string[] = []
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername(), origins, violations)
  const bob = await signUp(browser, 'Bob', bobUsername, origins, violations)
  await startChat(alice, bobUsername)

  const add = alice.getByRole('button', { name: 'Add attachment' })
  await add.focus()
  await add.press('ArrowUp')
  await alice.getByRole('menuitem', { name: 'Location', exact: true }).press('Enter')
  const preview = alice.getByRole('dialog', { name: 'Share this location?' })
  await expect(preview).toContainText('48.85840, 2.29450 · ±12 m')
  await expect(preview.getByRole('button', { name: 'Send location' })).toBeFocused()
  await preview.press('Escape')
  await expect(preview).toBeHidden()
  await expect(add).toBeFocused()
  await add.click()
  await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
  await preview.getByRole('button', { name: 'Send location' }).click()
  await expect(alice.getByLabel('Message', { exact: true })).toBeFocused()
  await expect(messages(alice).filter({ hasText: 'Location' }).getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()

  await expect(bob.getByRole('button', { name: /Alice/, includeHidden: true })).toContainText('Location')
  await openChat(bob, /Alice/)
  const card = messages(bob).getByTestId('location')
  await expect(card).toContainText('48.85840, 2.29450 · ±12 m')
  // Apple devices (Playwright's WebKit reports a Mac) open Apple Maps; others take geo:.
  await expect(card.getByRole('link', { name: 'Open in maps app' })).toHaveAttribute(
    'href',
    browserName === 'webkit' ? 'https://maps.apple.com/?ll=48.8584,2.2945&q=Shared%20location' : 'geo:48.8584,2.2945',
  )
  await card.getByRole('button', { name: 'Show map' }).click()
  // Drawn by MapLibre (WebGL), or a plain notice where the browser has none.
  await expect(card.locator('.maplibregl-canvas').or(card.getByText("The map can't be shown"))).toBeVisible()
  if (browserName === 'chromium') {
    await expect(card.locator('.maplibregl-canvas')).toBeVisible()
    await expect(card.locator('.maplibregl-marker')).toBeVisible()
  }
  expect(violations).toEqual([])

  expect([...origins].filter((o) => o !== new URL(baseURL!).origin && !o.startsWith('blob:') && o !== 'null')).toEqual(
    [],
  )
})

test('location preview actions stay aligned at narrow and wide viewport sizes', async ({ browser }) => {
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername(), new Set(), [])
  const bob = await signUp(browser, 'Bob', bobUsername, new Set(), [])
  await startChat(alice, bobUsername)

  for (const width of [320, 390, 768, 1280]) {
    await alice.setViewportSize({ width, height: 720 })
    const add = alice.getByRole('button', { name: 'Add attachment' })
    await add.click()
    await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
    const preview = alice.getByRole('dialog', { name: 'Share this location?' })
    await expect(preview).toBeVisible()
    const group = preview.getByRole('group', { name: 'Share live location for' })
    const durations = group.getByRole('button')
    await expect(durations).toHaveText(['15 min', '1 hour', '8 hours', 'Until stopped'])
    const bounds = (await group.boundingBox())!
    const boxes = await Promise.all((await durations.all()).map((button) => button.boundingBox()))
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(1)
    expect(Math.abs(boxes[2]!.y - boxes[3]!.y)).toBeLessThan(1)
    expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y)
    for (const box of boxes) expect(Math.abs(box!.width - boxes[0]!.width)).toBeLessThan(1)
    expect(Math.abs(boxes[2]!.x - boxes[0]!.x)).toBeLessThan(1)
    expect(Math.abs(boxes[3]!.x - boxes[1]!.x)).toBeLessThan(1)
    for (const name of ['Send location', 'Cancel']) {
      const box = (await preview.getByRole('button', { name, exact: true }).boundingBox())!
      expect(Math.abs(box.x - bounds.x)).toBeLessThan(1)
      expect(Math.abs(box.width - bounds.width)).toBeLessThan(1)
    }
    for (const button of await preview.locator('.actions').getByRole('button').all()) {
      await expect(button).toBeInViewport({ ratio: 1 })
      await expect(button).toHaveCSS('white-space', 'nowrap')
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(preview).toBeHidden()
    await expect(add).toBeFocused()
  }
  await alice.context().close()
  await bob.context().close()
})

test('live location follows the sender and is gone when they stop (FR-LOC-2/3/6)', async ({ browser }) => {
  test.setTimeout(90_000)
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername(), new Set(), [])
  const bob = await signUp(browser, 'Bob', bobUsername, new Set(), [])
  await startChat(alice, bobUsername)

  await alice.getByRole('button', { name: 'Add attachment' }).click()
  await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
  await alice.getByRole('dialog', { name: 'Share this location?' }).getByRole('button', { name: '15 min' }).click()
  await expect(alice.getByLabel('Message', { exact: true })).toBeFocused()
  // The indicator stays up while sharing (FR-LOC-6).
  const indicator = alice.getByRole('status', { name: /Sharing live location/ })
  await expect(indicator).toContainText(/Sharing live location · 15 min left/)

  await openChat(bob, /Alice/)
  const card = messages(bob).getByTestId('live-location')
  await expect(card).toContainText('Live location · until')
  await expect(card).toContainText('48.85840, 2.29450')

  // About 600 m east: sent once the 10-second floor has passed.
  await alice.context().setGeolocation({ latitude: 48.8584, longitude: 2.3027, accuracy: 8 })
  await expect(card).toContainText('48.85840, 2.30270 · ±8 m', { timeout: 30_000 })

  await alice.evaluate("location.hash = 'diagnostics'")
  await expect(alice.getByTestId('self-test')).toHaveText('passed')
  await expect(indicator).toBeVisible()
  await indicator.getByRole('button', { name: 'Stop' }).click()
  await expect(indicator).toBeHidden()
  await alice.getByRole('button', { name: '← Back', exact: true }).click()
  await expect(card).toHaveText('📍 Live location ended')
  await expect(messages(alice).getByTestId('live-location')).toHaveText('📍 Live location ended')
})

test('live-location controls remain available across conversations and Settings (FR-LOC-6)', async ({ browser }) => {
  const bobUsername = randomUsername()
  const carolUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername(), new Set(), [])
  await signUp(browser, 'Bob', bobUsername, new Set(), [])
  await signUp(browser, 'Carol', carolUsername, new Set(), [])
  await startChat(alice, bobUsername)

  await alice.getByRole('button', { name: 'Add attachment' }).click()
  await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
  await alice.getByRole('dialog', { name: 'Share this location?' }).getByRole('button', { name: '15 min' }).click()
  const indicators = alice.getByRole('status', { name: /Sharing live location/ })
  const bobIndicator = indicators.filter({ hasText: 'Bob' })
  await expect(bobIndicator).toBeVisible()

  await startChat(alice, carolUsername)
  await expect(alice.getByRole('heading', { name: 'Carol', exact: true })).toBeVisible({ timeout: 15_000 })
  await alice.getByRole('button', { name: 'Add attachment' }).click()
  await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
  await alice.getByRole('dialog', { name: 'Share this location?' }).getByRole('button', { name: '15 min' }).click()
  const carolIndicator = indicators.filter({ hasText: 'Carol' })
  await expect(indicators).toHaveCount(2)
  await expect(carolIndicator).toBeVisible()

  await openSettings(alice)
  await expect(indicators).toHaveCount(2)
  await carolIndicator.getByRole('button', { name: 'Stop' }).click()
  await expect(carolIndicator).toBeHidden()
  await bobIndicator.getByRole('button', { name: 'Stop' }).click()
  await expect(indicators).toHaveCount(0)
})

test('until-stopped location sharing continues until the sender stops it (FR-LOC-2/3/6)', async ({ browser }) => {
  test.setTimeout(90_000)
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername(), new Set(), [])
  const bob = await signUp(browser, 'Bob', bobUsername, new Set(), [])
  await startChat(alice, bobUsername)

  await alice.getByRole('button', { name: 'Add attachment' }).click()
  await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
  const preview = alice.getByRole('dialog', { name: 'Share this location?' })
  await expect(preview).toContainText('Live sharing pauses when this app is closed or in the background.')
  await expect(preview).toContainText('Recipients remove the last point after 8 hours without an update.')
  await preview.getByRole('button', { name: 'Until stopped' }).click()

  const indicator = alice.getByRole('status', { name: /Sharing live location/ })
  await expect(indicator).toContainText(/Sharing live location · until stopped/)
  await expect(indicator).toHaveAttribute('title', 'Sharing pauses when the app is closed or in the background.')

  await openChat(bob, /Alice/)
  const card = messages(bob).getByTestId('live-location')
  await expect(card).toContainText('Live location · until stopped')
  await expect(card).toContainText('48.85840, 2.29450')
  await expect(card).toHaveCount(1)

  // Both the contact photo and name open the same details view.
  await bob.locator('.conversation-title .avatar').click()
  const details = bob.getByRole('complementary', { name: 'Conversation details' })
  const contactLocation = details.getByRole('region', { name: 'Contact live location' })
  await expect(contactLocation).toBeVisible()
  await expect(contactLocation).toContainText('48.85840, 2.29450')
  await expect(details.getByTestId('safety-number')).toBeVisible()
  expect(await contactLocation.evaluate((el) => {
    const verification = el.parentElement!.querySelector('.verify')!
    return !!(el.compareDocumentPosition(verification) & 4) // DOCUMENT_POSITION_FOLLOWING
  })).toBe(true)

  await alice.context().setGeolocation({ latitude: 48.8584, longitude: 2.3027, accuracy: 8 })
  await expect(contactLocation).toContainText('48.85840, 2.30270 · ±8 m', { timeout: 30_000 })
  await expect(card).toContainText('48.85840, 2.30270 · ±8 m')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Live location · until stopped')

  await details.getByRole('button', { name: /^(Close details|Back to conversation)$/ }).click()
  await bob.locator('.conversation-title .conversation-name').click()
  await expect(contactLocation).toContainText('48.85840, 2.30270 · ±8 m')

  await indicator.getByRole('button', { name: 'Stop' }).click()
  await expect(indicator).toBeHidden()
  await expect(card).toHaveText('📍 Live location ended')
  await expect(contactLocation).toHaveCount(0)
})

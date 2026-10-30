import { type Browser, expect, test } from '@playwright/test'
import { messages, openChat, randomUsername } from './support'

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
  await expect(page.getByRole('status')).toHaveText('online')
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
  await alice.getByLabel("Contact's username").fill(bobUsername)
  await alice.getByRole('button', { name: 'Start chat' }).click()

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

  await expect(bob.getByRole('button', { name: /Alice/ })).toContainText('Location')
  await openChat(bob, /Alice/)
  const card = messages(bob).getByTestId('location')
  await expect(card).toContainText('48.85840, 2.29450 · ±12 m')
  await expect(card.getByRole('link', { name: 'Open in maps app' })).toHaveAttribute('href', 'geo:48.8584,2.2945')
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

test('live location follows the sender and is gone when they stop (FR-LOC-2/3/6)', async ({ browser }) => {
  test.setTimeout(90_000)
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername(), new Set(), [])
  const bob = await signUp(browser, 'Bob', bobUsername, new Set(), [])
  await alice.getByLabel("Contact's username").fill(bobUsername)
  await alice.getByRole('button', { name: 'Start chat' }).click()

  await alice.getByRole('button', { name: 'Add attachment' }).click()
  await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
  await alice.getByRole('dialog', { name: 'Share this location?' }).getByRole('button', { name: '15 min' }).click()
  await expect(alice.getByLabel('Message', { exact: true })).toBeFocused()
  // The indicator stays up while sharing (FR-LOC-6).
  const banner = alice.getByRole('status', { name: 'Sharing live location' })
  await expect(banner).toContainText(/Sharing live location with .* · 15 min left/)

  await openChat(bob, /Alice/)
  const card = messages(bob).getByTestId('live-location')
  await expect(card).toContainText('Live location · until')
  await expect(card).toContainText('48.85840, 2.29450')

  // About 600 m east: sent once the 10-second floor has passed.
  await alice.context().setGeolocation({ latitude: 48.8584, longitude: 2.3027, accuracy: 8 })
  await expect(card).toContainText('48.85840, 2.30270 · ±8 m', { timeout: 30_000 })

  await alice.evaluate("location.hash = 'diagnostics'")
  await expect(alice.getByTestId('self-test')).toHaveText('passed')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Stop' }).click()
  await expect(banner).toBeHidden()
  await alice.getByRole('button', { name: '← Back', exact: true }).click()
  await expect(card).toHaveText('📍 Live location ended')
  await expect(messages(alice).getByTestId('live-location')).toHaveText('📍 Live location ended')
})

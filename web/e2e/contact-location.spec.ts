import { writeFile } from 'node:fs/promises'
import { expect, test, type Page } from './fixtures'
import { closeDetails, conversationAction, conversationDetails, messages, openChat, randomUsername, signUp, startChat } from './support'

// These clients use only the isolated Playwright server and synthetic accounts.
test.skip(!process.env.E2E_SERVER, 'needs the isolated chat-server and PostgreSQL')

type GeoCounts = { fixes: number; watches: number; clears: number }
type GeoObservation = { lastWatchFix?: { latitude: number; longitude: number }; lastWatchError?: number }
type GeoEvent = {
  seq: number; elapsed: number; kind: string; visibility: DocumentVisibilityState; active: number[]
  watchId?: number; latitude?: number; longitude?: number; code?: number
}
type ProbeWindow = Window & { contactLocationProbe?: {
  counts: GeoCounts; observed: GeoObservation; history: GeoEvent[]; active: Set<number>
  mark(kind: string): void; restore(): void
} }

async function observeGeolocation(page: Page) {
  await page.evaluate(() => {
    const geo = navigator.geolocation
    const counts = { fixes: 0, watches: 0, clears: 0 }
    const observed: GeoObservation = {}
    const history: GeoEvent[] = []
    const active = new Set<number>()
    let sequence = 0
    const started = performance.now()
    const record = (kind: string, extra: Partial<GeoEvent> = {}) => {
      history.push({ seq: ++sequence, elapsed: Math.round(performance.now() - started), kind, visibility: document.visibilityState, active: [...active], ...extra })
      if (history.length > 80) history.shift()
    }
    const point = (position: GeolocationPosition) => ({ latitude: position.coords.latitude, longitude: position.coords.longitude })
    const keys = ['getCurrentPosition', 'watchPosition', 'clearWatch'] as const
    const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(geo, key))
    const originals = {
      getCurrentPosition: geo.getCurrentPosition.bind(geo),
      watchPosition: geo.watchPosition.bind(geo),
      clearWatch: geo.clearWatch.bind(geo),
    }
    Object.defineProperties(geo, {
      getCurrentPosition: { configurable: true, value: (...[success, error, options]: Parameters<Geolocation['getCurrentPosition']>) => {
        counts.fixes++
        record('get-call')
        return originals.getCurrentPosition((position) => { record('get-success', point(position)); success(position) },
          (failure) => { record('get-error', { code: failure.code }); error?.(failure) }, options)
      } },
      watchPosition: { configurable: true, value: (...[success, error, options]: Parameters<Geolocation['watchPosition']>) => {
        counts.watches++
        record('watch-call')
        let watchId: number
        watchId = originals.watchPosition((position) => {
          observed.lastWatchFix = point(position)
          record('watch-success', { watchId, ...point(position) })
          success(position)
        }, (failure) => {
          observed.lastWatchError = failure.code
          record('watch-error', { watchId, code: failure.code })
          error?.(failure)
        }, options)
        active.add(watchId)
        record('watch-return', { watchId })
        return watchId
      } },
      clearWatch: { configurable: true, value: (watchId: number) => {
        counts.clears++
        const result = originals.clearWatch(watchId)
        active.delete(watchId)
        record('watch-clear', { watchId })
        return result
      } },
    })
    const visibility = () => record('visibilitychange')
    const pageHide = () => record('pagehide')
    const pageShow = () => record('pageshow')
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', pageHide)
    window.addEventListener('pageshow', pageShow)
    ;(window as ProbeWindow).contactLocationProbe = {
      counts,
      observed,
      history,
      active,
      mark: (kind) => record(kind),
      restore: () => {
        document.removeEventListener('visibilitychange', visibility)
        window.removeEventListener('pagehide', pageHide)
        window.removeEventListener('pageshow', pageShow)
        keys.forEach((key, index) => {
          if (descriptors[index]) Object.defineProperty(geo, key, descriptors[index]!)
          else Reflect.deleteProperty(geo, key)
        })
        delete (window as ProbeWindow).contactLocationProbe
      },
    }
  })
}
const geoCounts = (page: Page) => page.evaluate(() => ({ ...(window as ProbeWindow).contactLocationProbe!.counts }))
const locality = (page: Page) => page.locator('.conversation-bar .issue132-recipient-locality')

async function sendText(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(messages(page).filter({ hasText: text }).getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()
}

async function locationPreview(page: Page) {
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Location', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Share this location?', exact: true })
  await expect(preview).toBeVisible()
  return preview
}

test('explicit contact sharing supplies city/state and contact-name maps, never other contacts', async ({ browser }) => {
  test.setTimeout(120_000) // 3 isolated accounts, 2 accepted conversations and encrypted live updates.
  const aliceName = randomUsername()
  const bobName = randomUsername()
  const carolName = randomUsername()
  const alice = await signUp(browser, 'Alice', aliceName)
  const bob = await signUp(browser, 'Bob', bobName)
  const carol = await signUp(browser, 'Carol', carolName)
  const clients = [alice, bob, carol]
  try {
    // Install Firefox's override before the observer first reads navigator.geolocation.
    // An instance created before the override can retain a stale native watch provider.
    await alice.context().setGeolocation({ latitude: 37.7749, longitude: -122.4194, accuracy: 12 })
    await alice.context().grantPermissions(['geolocation'])
    for (const page of clients) await observeGeolocation(page)

    await startChat(alice, bobName)
    await expect(alice.getByRole('region', { name: 'Conversation with Bob', exact: true })
      .or(alice.getByRole('region', { name: `Conversation with ${bobName}`, exact: true }))).toBeVisible()
    await sendText(alice, 'Ready for Bob')
    await openChat(bob, /Alice/)
    await startChat(alice, carolName)
    await expect(alice.getByRole('region', { name: 'Conversation with Carol', exact: true })
      .or(alice.getByRole('region', { name: `Conversation with ${carolName}`, exact: true }))).toBeVisible()
    await sendText(alice, 'Ready for Carol')
    await openChat(carol, /Alice/)
    for (const page of clients) {
      await expect(locality(page)).toHaveCount(0)
      expect(await geoCounts(page)).toEqual({ fixes: 0, watches: 0, clears: 0 })
    }

    await alice.bringToFront()
    await openChat(alice, /Bob/)
    const oneShot = await locationPreview(alice)
    await oneShot.getByRole('button', { name: 'Send location', exact: true }).click()
    await expect(locality(bob)).toHaveText('Near San Francisco, CA')
    await expect(locality(alice)).toHaveCount(0)
    await expect(locality(carol)).toHaveCount(0)
    expect(await geoCounts(alice)).toEqual({ fixes: 1, watches: 0, clears: 0 })

    const preview = await locationPreview(alice)
    await preview.getByRole('button', { name: '15 min', exact: true }).click()
    await expect(messages(alice).getByTestId('live-location')).toContainText('37.77490, -122.41940')
    await expect(locality(bob)).toHaveText('Near San Francisco, CA')
    await expect(locality(alice)).toHaveCount(0) // Our shared point is not Bob's location.
    await expect(locality(carol)).toHaveCount(0)
    expect(await geoCounts(bob)).toEqual({ fixes: 0, watches: 0, clears: 0 })
    expect(await geoCounts(carol)).toEqual({ fixes: 0, watches: 0, clears: 0 })
    expect((await geoCounts(alice)).fixes).toBe(2)

    await bob.bringToFront()
    const name = bob.locator('.conversation-bar').getByRole('button', { name: 'Contact details', exact: true })
    await name.click()
    const shared = conversationDetails(bob).getByRole('region', { name: 'Contact live location', exact: true })
    await expect(shared).toContainText('37.77490, -122.41940')
    await expect(shared.locator('.maplibregl-canvas').or(shared.getByText("The map can't be shown"))).toBeVisible()
    await closeDetails(bob)
    await expect(name).toBeFocused()
    expect(await geoCounts(bob)).toEqual({ fixes: 0, watches: 0, clears: 0 })

    await alice.bringToFront()
    await expect.poll(() => alice.evaluate(() => ({
      visibility: document.visibilityState,
      activeWatches: (window as ProbeWindow).contactLocationProbe!.counts.watches - (window as ProbeWindow).contactLocationProbe!.counts.clears,
    }))).toEqual({ visibility: 'visible', activeWatches: 1 })
    await alice.evaluate(() => (window as ProbeWindow).contactLocationProbe!.mark('before-set-LA'))
    await alice.context().setGeolocation({ latitude: 34.0522, longitude: -118.2437, accuracy: 12 })
    await alice.evaluate(() => (window as ProbeWindow).contactLocationProbe!.mark('after-set-LA'))
    await expect.poll(() => alice.evaluate(() => (window as ProbeWindow).contactLocationProbe!.observed), { timeout: 10_000 }).toMatchObject({
      lastWatchFix: { latitude: 34.0522, longitude: -118.2437 },
    })
    // First observe sender acceptance, then encrypted delivery and its derived header.
    await expect(messages(alice).getByTestId('live-location')).toContainText('34.05220, -118.24370 · ±12 m', { timeout: 30_000 })
    await expect(messages(bob).getByTestId('live-location')).toContainText('34.05220, -118.24370 · ±12 m')
    await expect(locality(bob)).toHaveText('Near Los Angeles, CA')
    await expect(locality(carol)).toHaveCount(0)
    expect(await geoCounts(bob)).toEqual({ fixes: 0, watches: 0, clears: 0 })
    expect(await geoCounts(carol)).toEqual({ fixes: 0, watches: 0, clears: 0 })
    await conversationAction(alice, 'Stop sharing location')
    await expect(locality(bob)).toHaveCount(0)
    await name.click()
    await expect(conversationDetails(bob).getByRole('region', { name: 'Contact live location', exact: true })).toHaveCount(0)
    await expect(locality(carol)).toHaveCount(0)
    expect(await geoCounts(carol)).toEqual({ fixes: 0, watches: 0, clears: 0 })
  } catch (error) {
    try {
      const snapshot = (page: Page) => page.evaluate(() => {
        const probe = (window as ProbeWindow).contactLocationProbe!
        const cards = [...document.querySelectorAll('[data-testid="live-location"]')].map((card) => ({
          sf: card.textContent?.includes('37.77490, -122.41940'), la: card.textContent?.includes('34.05220, -118.24370'),
        }))
        return { counts: probe.counts, observed: probe.observed, history: probe.history, active: [...probe.active], visibility: document.visibilityState, cards }
      })
      const observations = await Promise.all(clients.map(snapshot))
      const path = test.info().outputPath('native-location-observations.json')
      await writeFile(path, JSON.stringify({ observations }, null, 2))
      await test.info().attach('native-location-observations', { contentType: 'application/json', path })
    } catch {
      // A closed page or an incomplete probe must not replace the original test failure.
    }
    throw error
  } finally {
    for (const page of clients) {
      await page.evaluate(() => (window as ProbeWindow).contactLocationProbe?.restore()).catch(() => {})
    }
  }
})

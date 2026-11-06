import { expect, test } from './fixtures'
import { fixtureAction, fixtureSend, openFixture } from './interaction-fixture-support'
import { messages } from './support'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; this suite requires the in-memory UI fixture')

// UI contracts only. The fixture substitutes an in-memory core and a local
// BroadcastChannel. These tests do not prove encrypted transport or persistence.
test('links expose isolated Open, Copy, and Share actions without fetching previews', async ({ page }) => {
  const url = 'https://example.invalid/reference?q=one&x=two#section'
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { document.documentElement.dataset.copied = text } },
    })
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: ShareData) => { document.documentElement.dataset.shared = data.url },
    })
  })
  const requests: string[] = []
  await page.context().route('https://example.invalid/**', async (route) => {
    requests.push(route.request().url())
    await route.fulfill({ contentType: 'text/html', body: '<title>Local destination fixture</title>' })
  })
  await openFixture(page)
  await fixtureAction(page, 'incoming', `Read ${url} and javascript:alert(1)`)
  const message = messages(page).last()
  const link = message.getByRole('link', { name: url, exact: true })
  await expect(link).toHaveAttribute('href', url)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
  await expect(message.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(message).toContainText('javascript:alert(1)')
  expect(requests).toEqual([])
  await message.getByLabel(`Actions for ${url}`, { exact: true }).click()
  await message.getByRole('button', { name: 'Copy link', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-copied', url)
  await message.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-shared', url)
  const popupPromise = page.waitForEvent('popup')
  await message.getByRole('link', { name: 'Open', exact: true }).click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  expect(popup.url()).toBe(url)
  expect(await popup.evaluate(() => window.opener === null)).toBe(true)
  await popup.close()
})

test('a quoted reply can be cancelled without losing the draft and appears on the other client', async ({ context, page }) => {
  const bob = await context.newPage()
  const room = 'quoted-reply'
  await openFixture(page, 'Alice', room)
  await openFixture(bob, 'Bob', room)
  await fixtureSend(bob, 'Original message')
  const original = messages(page).filter({ hasText: 'Original message' }).last()
  await expect(original).toBeVisible()
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft')
  await original.getByRole('button', { name: 'Reply to Bob', exact: true }).click()
  const preview = page.getByRole('complementary', { name: 'Replying to message', exact: true })
  await expect(preview).toContainText('Original message')
  await page.getByRole('button', { name: 'Cancel reply', exact: true }).click()
  await expect(preview).toHaveCount(0)
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft')
  await original.getByRole('button', { name: 'Reply to Bob', exact: true }).click()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(preview).toHaveCount(0)
  const received = messages(bob).filter({ hasText: 'Keep this draft' }).last()
  await expect(received.getByRole('complementary', { name: 'Quoted message', exact: true })).toContainText('Original message')
  await bob.close()
})

test('a reply with no local original remains readable', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'missingReply')
  const reply = messages(page).last()
  await expect(reply).toContainText('Reply without local original')
  await expect(reply).toContainText('Original message unavailable')
  await expect(page.getByTestId('fixture-error')).toHaveCount(0)
})

test('typing reaches another client, expires without a stop, and clears after send', async ({ context, page }) => {
  test.setTimeout(30_000)
  const bob = await context.newPage()
  await openFixture(page, 'Alice', 'typing')
  await openFixture(bob, 'Bob', 'typing')
  await fixtureAction(bob, 'dropTypingStops', 1)
  const typing = bob.getByRole('status').filter({ hasText: 'Alice is typing' })
  await page.getByLabel('Message', { exact: true }).fill('A pending draft')
  await expect(typing).toBeVisible()
  // Do not clear the draft. The receiver must eventually expire the indicator.
  await expect(typing).toHaveCount(0, { timeout: 15_000 })
  await fixtureAction(bob, 'dropTypingStops', 0)
  await page.getByLabel('Message', { exact: true }).fill('A changed draft')
  await expect(typing).toBeVisible()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(messages(bob).last()).toContainText('A changed draft')
  await expect(typing).toHaveCount(0)
  await bob.close()
})


test('long URLs fit a narrow screen and clipboard errors remain actionable without Share', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied by fixture') } },
    })
  })
  await openFixture(page)
  const url = 'https://example.invalid/' + 'a'.repeat(600)
  await fixtureAction(page, 'incoming', url)
  const message = messages(page).last()
  await expect(message.getByRole('link', { name: url, exact: true })).toBeVisible()
  await expect.poll(() => page.locator('.messages-viewport').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  await expect.poll(() => page.locator('html').evaluate((el) => el.scrollWidth)).toBe(390)
  await message.getByLabel('Actions for ' + url, { exact: true }).click()
  await expect(message.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0)
  await message.getByRole('button', { name: 'Copy link', exact: true }).click()
  await expect(message.getByRole('alert')).toContainText('Clipboard denied by fixture')
  await expect(message.getByRole('link', { name: 'Open', exact: true })).toBeVisible()
})

test('cancelling a native Share action does not show an error', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true, value: async () => { throw new DOMException('Cancelled', 'AbortError') },
    })
  })
  await openFixture(page)
  await fixtureAction(page, 'incoming', 'https://example.invalid/cancel')
  const message = messages(page).last()
  await message.getByLabel('Actions for https://example.invalid/cancel', { exact: true }).click()
  await message.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(message.getByRole('alert')).toHaveCount(0)
})

test('a failed send restores its draft and quote but never overwrites a newer pair', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', 'First original')
  const first = messages(page).filter({ hasText: 'First original' })
  await first.getByRole('button', { name: 'Reply to Bob', exact: true }).click()
  await page.getByLabel('Message', { exact: true }).fill('First reply draft')
  await fixtureAction(page, 'holdNextSend')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
  await fixtureAction(page, 'rejectSend')
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('First reply draft')
  const preview = page.getByRole('complementary', { name: 'Replying to message', exact: true })
  await expect(preview).toContainText('First original')
  await fixtureAction(page, 'holdNextSend')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
  await fixtureAction(page, 'incoming', 'Second original')
  await messages(page).filter({ hasText: 'Second original' }).getByRole('button', { name: 'Reply to Bob', exact: true }).click()
  await page.getByLabel('Message', { exact: true }).fill('Newer reply draft')
  await fixtureAction(page, 'rejectSend')
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Newer reply draft')
  await expect(preview).toContainText('Second original')
  await expect(preview).not.toContainText('First original')
  await expect(page.getByText('First reply draft', { exact: true })).toBeVisible()
})


test('continuous edits renew typing but blur and hidden state stop it', async ({ context, page }) => {
  const bob = await context.newPage()
  await openFixture(page, 'Alice', 'typing-renewal')
  await openFixture(bob, 'Bob', 'typing-renewal')
  await page.clock.install()
  await bob.clock.install()
  const input = page.getByLabel('Message', { exact: true })
  const typing = bob.getByRole('status').filter({ hasText: 'Alice is typing' })
  await input.fill('Edit 0')
  await expect(typing).toBeVisible()
  // More than one 8-second lease elapses, but continued edits renew it.
  for (let i = 1; i <= 4; i++) {
    await page.clock.fastForward(2500)
    await bob.clock.fastForward(2500)
    await input.fill('Edit ' + i)
    await expect(typing).toBeVisible()
  }
  await input.press('Tab')
  await expect(typing).toHaveCount(0)
  await input.fill('Fresh edit after focus')
  await expect(typing).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(typing).toHaveCount(0)
  await bob.close()
})

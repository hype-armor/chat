import { expect, test } from './fixtures'
import { fixtureAction, openFixture } from './interaction-fixture-support'
import { messages } from './support'

test.skip(!process.env.E2E_UI_FIXTURES, 'requires the in-memory UI fixture')

for (const width of [390, 1280]) {
  test(`multiline edits preserve reading position and pinned bottom (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.addInitScript(() => {
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 }),
      })
    })
    await openFixture(page)
    await fixtureAction(page, 'seed', 50)
    await expect(messages(page)).toHaveCount(50)
    const viewport = page.locator('.messages-viewport')
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    const gap = () => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    const height = () => input.evaluate((el) => el.getBoundingClientRect().height)
    await expect.poll(gap).toBeLessThanOrEqual(1)
    const initialHeight = await height()
    await input.fill('One line')
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeVisible()
    await expect(send).toHaveText('')
    await input.fill('First line\nSecond line\nThird line')
    await expect.poll(height).toBeGreaterThan(initialHeight)
    await expect.poll(gap).toBeLessThanOrEqual(1)
    await input.fill('Short')
    await expect.poll(height).toBeCloseTo(initialHeight, 0)
    await expect.poll(gap).toBeLessThanOrEqual(1)

    const anchor = messages(page).nth(20)
    await viewport.evaluate((el) => {
      const target = el.querySelectorAll('[data-testid="message"]')[20] as HTMLElement
      el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 20
    })
    await expect(anchor).toBeInViewport()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const position = () => anchor.evaluate((el) => el.getBoundingClientRect().top - el.closest('.messages-viewport')!.getBoundingClientRect().top)
    const original = await position()
    await input.fill('First line\nSecond line\nThird line\nFourth line')
    await expect.poll(position).toBeCloseTo(original, 0)
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 500, offsetTop: 344 })
      window.visualViewport!.dispatchEvent(new Event('resize'))
    })
    await expect(page.locator('html')).toHaveCSS('--app-height', '500px')
    await expect.poll(position).toBeCloseTo(original, 0)
    await input.fill('Short')
    await expect.poll(position).toBeCloseTo(original, 0)
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 })
      window.visualViewport!.dispatchEvent(new Event('resize'))
    })
    await expect(page.locator('html')).toHaveCSS('--app-height', '844px')
    await expect.poll(position).toBeCloseTo(original, 0)
  })
}

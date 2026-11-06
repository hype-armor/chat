import { type Page, expect, test } from '@playwright/test'
import { messages } from './support'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; this suite requires the in-memory UI fixture')
import { fixtureAction, openFixture } from './interaction-fixture-support'

// In-memory core only. No server or encrypted delivery claims.

async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(messages(page).filter({ hasText: text }).getByRole('img', {
    name: /^(Sent|Delivered|Read)$/,
  })).toBeVisible()
}

// Existing chat.spec.ts covers opening, own sends, incoming messages, and
// synthetic content growth. These cases add keyboard and actual image layout.
for (const width of [390, 1280]) {
  test(`keyboard and image resize preserve a history reader (${width}px)`, async ({ browser }) => {
    test.setTimeout(120_000)
    const alice = await (await browser.newContext()).newPage()
    try {
      await alice.setViewportSize({ width, height: 844 })
      await alice.addInitScript(() => {
        Object.defineProperty(window, 'visualViewport', {
          configurable: true,
          value: Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 }),
        })
      })
      await openFixture(alice)
      await fixtureAction(alice, 'seed', 26)
      await expect(messages(alice)).toHaveCount(26)
      const viewport = alice.locator('.messages-viewport')
      const pill = alice.getByRole('button', { name: '↓ New messages' })
      const bottomGap = () => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
      await expect.poll(bottomGap).toBeLessThanOrEqual(1)
      await fixtureAction(alice, 'incoming', 'Incoming while pinned')
      await expect(messages(alice).last()).toContainText('Incoming while pinned')
      await expect.poll(bottomGap).toBeLessThanOrEqual(1)

      await viewport.evaluate((el) => { el.scrollTop = 0 })
      await expect(messages(alice).first()).toBeInViewport()
      // Let the user scroll event reach the pin-state handler.
      await alice.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const anchor = messages(alice).first()
      const relativeTop = () => anchor.evaluate((el) => {
        const viewport = el.closest('.messages-viewport')!
        return el.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      })
      const originalTop = await relativeTop()
      const changeKeyboard = async (height: number, offsetTop: number) => {
        await alice.evaluate(({ height, offsetTop }) => {
          Object.assign(window.visualViewport!, { height, offsetTop })
          window.visualViewport!.dispatchEvent(new Event('resize'))
        }, { height, offsetTop })
        await expect(alice.locator('html')).toHaveCSS('--app-height', `${height}px`)
      }
      await changeKeyboard(500, 344)
      await expect.poll(relativeTop).toBeCloseTo(originalTop, 0)
      await fixtureAction(alice, 'incoming', 'Incoming while the keyboard is open')
      await expect(pill).toBeVisible()
      await expect.poll(relativeTop).toBeCloseTo(originalTop, 0)
      await changeKeyboard(844, 0)
      await expect.poll(relativeTop).toBeCloseTo(originalTop, 0)

      // Use a real decoded local image, not an external origin or a new
      // message event. This isolates ResizeObserver from transport updates.
      const growImage = async () => {
        await messages(alice).last().evaluate(async (message) => {
          const canvas = document.createElement('canvas')
          canvas.width = 100
          canvas.height = 300
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = '#789'
          ctx.fillRect(0, 0, 100, 300)
          const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
          const url = URL.createObjectURL(blob)
          const image = document.createElement('img')
          image.alt = 'Delayed layout fixture'
          image.style.display = 'block'
          image.src = url
          await image.decode()
          message.append(image)
          URL.revokeObjectURL(url)
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        })
      }
      await growImage()
      await expect.poll(relativeTop).toBeCloseTo(originalTop, 0)
      await expect(pill).toBeVisible()
      await pill.click()
      await expect.poll(bottomGap).toBeLessThanOrEqual(1)
      await growImage()
      await expect.poll(bottomGap).toBeLessThanOrEqual(1)
      await changeKeyboard(500, 344)
      await expect.poll(bottomGap).toBeLessThanOrEqual(1)
      await changeKeyboard(844, 0)
      await expect.poll(bottomGap).toBeLessThanOrEqual(1)

      await viewport.evaluate((el) => { el.scrollTop = 0 })
      await expect(anchor).toBeInViewport()
      await send(alice, 'Own send must return to the bottom')
      await expect.poll(bottomGap).toBeLessThanOrEqual(1)
      await expect(pill).toHaveCount(0)
    } finally {
      await alice.context().close()
    }
  })
}


test('a mid-history message stays anchored when an image above it grows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openFixture(page)
  await fixtureAction(page, 'seed', 50)
  await expect(messages(page)).toHaveCount(50)
  const anchor = messages(page).nth(20)
  await page.locator('.messages-viewport').evaluate((viewport) => {
    const target = viewport.querySelectorAll('[data-testid="message"]')[20] as HTMLElement
    viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 20
  })
  await expect(anchor).toBeInViewport()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const position = () => anchor.evaluate((el) => el.getBoundingClientRect().top - el.closest('.messages-viewport')!.getBoundingClientRect().top)
  const original = await position()
  await messages(page).first().evaluate(async (el) => {
    const canvas = document.createElement('canvas')
    canvas.width = 120
    canvas.height = 240
    const url = canvas.toDataURL('image/png')
    const image = document.createElement('img')
    image.alt = 'Media above the reading position'
    image.src = url
    await image.decode()
    el.append(image)
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  await expect.poll(position).toBeCloseTo(original, 0)
  await fixtureAction(page, 'incoming', 'Another message below the reader')
  await expect(page.getByRole('button', { name: '↓ New messages' })).toBeVisible()
  await expect.poll(position).toBeCloseTo(original, 0)
})


test('a queued mid-history scroll wins over a simultaneous container resize', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openFixture(page)
  await fixtureAction(page, 'seed', 50)
  await expect(messages(page)).toHaveCount(50)
  const viewport = page.locator('.messages-viewport')
  await expect.poll(() => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1)
  const expected = await viewport.evaluate((el) => {
    const target = el.querySelectorAll('[data-testid="message"]')[20] as HTMLElement
    // No event dispatch or await between the user-position change and resize.
    el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 20
    const offset = target.getBoundingClientRect().top - el.getBoundingClientRect().top
    el.style.flex = '0 0 300px'
    el.style.height = '300px'
    return offset
  })
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const anchor = messages(page).nth(20)
  await expect(anchor).toBeInViewport()
  await expect.poll(() => anchor.evaluate((el) => el.getBoundingClientRect().top - el.closest('.messages-viewport')!.getBoundingClientRect().top)).toBeCloseTo(expected, 0)
  await fixtureAction(page, 'incoming', 'Incoming after queued user scroll')
  await expect(page.getByRole('button', { name: '↓ New messages' })).toBeVisible()
  await expect.poll(() => anchor.evaluate((el) => el.getBoundingClientRect().top - el.closest('.messages-viewport')!.getBoundingClientRect().top)).toBeCloseTo(expected, 0)
})

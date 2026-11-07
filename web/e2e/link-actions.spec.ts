import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { fixtureAction, openFixture } from './interaction-fixture-support'
import { messages } from './support'

test.skip(!process.env.E2E_UI_FIXTURES, 'requires the isolated in-memory UI fixture')

const url = 'https://example.invalid/link-actions?q=one&x=two#section'
const pointer = { pointerId: 17, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 100 }

async function contextMenu(link: Locator, x = 100, y = 100) {
  // Playwright dispatchEvent('contextmenu') uses a generic Event in this setup.
  // Construct a MouseEvent so React receives real client coordinates.
  return link.evaluate((element, { x, y }) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
    element.dispatchEvent(event)
    return event.defaultPrevented
  }, { x, y })
}

async function settleLinkLayout(link: Locator) {
  await expect(link).toBeVisible()
  await link.evaluate(async (element) => {
    await document.fonts.ready
    const messages = element.closest('.messages-viewport')!
    const viewport = window.visualViewport
    let notifications = 0
    const changed = () => { notifications++ }
    document.addEventListener('scroll', changed, true)
    viewport?.addEventListener('scroll', changed)
    viewport?.addEventListener('resize', changed)
    try {
      let previous = ''
      let quietFrames = 0
      // A layout effect already set scrollTop, but its native scroll event can
      // still be queued. Require stable geometry AND notifications across frames.
      while (quietFrames < 2) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        if (!element.isConnected) throw new Error('The link disappeared before layout settled')
        const bounds = element.getBoundingClientRect()
        const sample = JSON.stringify([
          bounds.x, bounds.y, bounds.width, bounds.height,
          messages.scrollTop, messages.scrollHeight, messages.clientWidth, messages.clientHeight,
          viewport?.width, viewport?.height, viewport?.offsetLeft, viewport?.offsetTop, notifications,
        ])
        quietFrames = sample === previous ? quietFrames + 1 : 0
        previous = sample
      }
    } finally {
      document.removeEventListener('scroll', changed, true)
      viewport?.removeEventListener('scroll', changed)
      viewport?.removeEventListener('resize', changed)
    }
  })
}

async function selectLink(link: Locator) {
  await link.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
}

// UI contracts only. No chat services, clipboard services, or external pages.
test('links have no visible disclosure, preserve normal clicks, and never fetch previews', async ({ page, context }) => {
  const requests: { url: string; referer?: string }[] = []
  await context.route('https://example.invalid/**', async (route) => {
    requests.push({ url: route.request().url(), referer: route.request().headers().referer })
    await route.fulfill({ contentType: 'text/html', body: '<title>Local link destination</title>' })
  })
  await openFixture(page)
  await fixtureAction(page, 'incoming', `Read ${url} and javascript:alert(1)`)
  const message = messages(page).last()
  const link = message.getByRole('link', { name: url, exact: true })
  await expect(link).toHaveAttribute('href', url)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect(message.locator('details, summary')).toHaveCount(0)
  await expect(page.getByRole('menu', { name: 'Link actions', exact: true })).toHaveCount(0)
  await expect(message.getByRole('button', { name: 'Copy link', exact: true })).toHaveCount(0)
  await expect(message.locator('a[href^="javascript:"]')).toHaveCount(0)
  expect(requests).toEqual([])

  const popupPromise = page.waitForEvent('popup')
  await link.click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  expect(popup.url()).toBe(url)
  expect(await popup.evaluate(() => window.opener === null)).toBe(true)
  expect(requests).toEqual([{ url: url.split('#')[0], referer: undefined }])
  await popup.close()
  await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0)
})

test('keyboard and right-click menus isolate Open, Copy, and Share and restore link focus', async ({ page, context }) => {
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
  await context.route('https://example.invalid/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Local destination</title>' }))
  await openFixture(page)
  await fixtureAction(page, 'incoming', url)
  const link = messages(page).last().getByRole('link', { name: url, exact: true })
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await link.focus()
  await link.press('Shift+F10')
  const open = menu.getByRole('menuitem', { name: 'Open', exact: true })
  const copy = menu.getByRole('menuitem', { name: 'Copy link', exact: true })
  const share = menu.getByRole('menuitem', { name: 'Share', exact: true })
  await expect(open).toBeFocused()
  await open.press('ArrowDown')
  await expect(copy).toBeFocused()
  await copy.press('Enter')
  await expect(page.locator('html')).toHaveAttribute('data-copied', url)
  await expect(menu.getByRole('status')).toHaveText('Link copied')
  await copy.press('End')
  await expect(share).toBeFocused()
  await share.press('Enter')
  await expect(page.locator('html')).toHaveAttribute('data-shared', url)
  await share.press('Home')
  await expect(open).toBeFocused()
  await open.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(link).toBeFocused()
  await link.press('ContextMenu')
  await expect(open).toBeFocused()
  await open.press('Tab')
  await expect(menu).toHaveCount(0)

  await link.click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0)
  await expect(open).toHaveAttribute('target', '_blank')
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(open).toHaveAttribute('referrerpolicy', 'no-referrer')
  for (const key of ['Enter', 'Space']) {
    if (key === 'Space') {
      await link.focus()
      await link.press('ContextMenu')
    }
    const popupPromise = page.waitForEvent('popup')
    await open.press(key)
    const popup = await popupPromise
    await popup.waitForLoadState()
    expect(popup.url()).toBe(url)
    expect(await popup.evaluate(() => window.opener === null)).toBe(true)
    await popup.close()
    await expect(menu).toHaveCount(0)
  }
  await expect(page.getByRole('complementary', { name: 'Replying to message', exact: true })).toHaveCount(0)
})

test('link menus dismiss on outside pointer and focus without changing a draft', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', url)
  const link = messages(page).last().getByRole('link', { name: url, exact: true })
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill('Keep this draft')
  await link.focus()
  await link.press('ContextMenu')
  await expect(menu).toBeVisible()
  await composer.focus()
  await expect(menu).toHaveCount(0)
  await expect(composer).toBeFocused()
  await link.click({ button: 'right' })
  await expect(menu).toBeVisible()
  await composer.click()
  await expect(menu).toHaveCount(0)
  await expect(composer).toHaveValue('Keep this draft')
})

test('conversation, link, and message menus dismiss each other without cancelling new gestures', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', `Menu coexistence ${url}`)
  const message = messages(page).last()
  const link = message.getByRole('link', { name: url, exact: true })
  const trigger = page.getByRole('button', { name: 'Conversation menu', exact: true })
  const conversationMenu = page.getByRole('menu', { name: 'Conversation menu', exact: true })
  const linkMenu = page.getByRole('menu', { name: 'Link actions', exact: true })
  const messageMenu = page.getByRole('menu', { name: 'Message actions', exact: true })
  await page.clock.install()

  await trigger.click()
  await expect(conversationMenu).toBeVisible()
  await link.dispatchEvent('pointerdown', pointer)
  await expect(conversationMenu).toHaveCount(0)
  await page.clock.runFor(600)
  await expect(linkMenu).toBeVisible()
  await link.dispatchEvent('pointerup', pointer)
  await expect(messageMenu).toHaveCount(0)

  await message.focus()
  await expect(linkMenu).toHaveCount(0)
  await message.press('Shift+F10')
  await expect(messageMenu).toBeVisible()
  await link.click({ button: 'right' })
  await expect(linkMenu).toBeVisible()
  await expect(messageMenu).toHaveCount(0)
  await expect(conversationMenu).toHaveCount(0)

  await trigger.click()
  await expect(linkMenu).toHaveCount(0)
  await expect(conversationMenu).toBeVisible()
  await message.dispatchEvent('pointerdown', { ...pointer, pointerId: 18 })
  await expect(conversationMenu).toHaveCount(0)
  await page.clock.runFor(600)
  await expect(messageMenu).toBeVisible()
  await expect(linkMenu).toHaveCount(0)
  await message.dispatchEvent('pointerup', { ...pointer, pointerId: 18 })
  await page.keyboard.press('Escape')
  await expect(message).toBeFocused()
})

test('touch release, movement, scroll, and cancellation prevent delayed link menus', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', url)
  const link = messages(page).last().getByRole('link', { name: url, exact: true })
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await page.clock.install()
  for (const cancel of ['movement', 'scroll', 'pointercancel', 'pointerup']) {
    await link.dispatchEvent('pointerdown', pointer)
    if (cancel === 'movement') await link.dispatchEvent('pointermove', { ...pointer, clientX: pointer.clientX + 20 })
    else if (cancel === 'scroll') await page.locator('.messages-viewport').evaluate((element) => element.dispatchEvent(new Event('scroll')))
    else await link.dispatchEvent(cancel, pointer)
    await page.clock.runFor(600)
    expect(await contextMenu(link)).toBe(false)
    await expect(menu).toHaveCount(0)
    await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0)
  }
})

test('owned link long press survives delayed selection and contextmenu after release without opening Reply', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', url)
  const link = messages(page).last().getByRole('link', { name: url, exact: true })
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await page.clock.install()
  await link.dispatchEvent('pointerdown', pointer)
  await selectLink(link) // Model native selection that starts during this gesture.
  await page.clock.runFor(600)
  await expect(menu).toBeVisible()
  await link.dispatchEvent('pointerup', pointer)
  await selectLink(link) // Some mobile browsers select only after release.
  expect(await contextMenu(link)).toBe(true)
  await expect(menu).toBeVisible()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
  expect(await link.evaluate((element) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })).toBe(true)
  await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(link).toBeFocused()
  await expect(menu).toHaveCount(0)
})

test('pre-existing selection retains native link handling and never opens Reply', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', url)
  const link = messages(page).last().getByRole('link', { name: url, exact: true })
  await page.clock.install()
  await selectLink(link)
  await link.dispatchEvent('pointerdown', pointer)
  await page.clock.runFor(600)
  await link.dispatchEvent('pointerup', pointer)
  expect(await contextMenu(link)).toBe(false)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(url)
  await expect(page.getByRole('menu', { name: 'Link actions', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0)
})

test('a narrow bottom-right menu re-clamps growing errors without stealing focus and allows internal scroll', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 500 })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied by fixture. ' + 'Select the link to copy it manually. '.repeat(200)) } },
    })
  })
  await openFixture(page)
  const longUrl = 'https://example.invalid/' + 'a'.repeat(600)
  await fixtureAction(page, 'incoming', longUrl)
  const link = messages(page).last().getByRole('link', { name: longUrl, exact: true })
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await settleLinkLayout(link)
  expect(await contextMenu(link, 389, 499)).toBe(true)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused()
  await expect(menu.getByRole('menuitem', { name: 'Share', exact: true })).toHaveCount(0)
  const before = (await menu.boundingBox())!
  const copy = menu.getByRole('menuitem', { name: 'Copy link', exact: true })
  await copy.focus()
  await copy.press('Enter')
  await expect(menu.getByRole('alert')).toContainText('Clipboard denied by fixture')
  await expect(copy).toBeFocused()
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible()
  const bounds = (await menu.boundingBox())!
  await testInfo.attach('menu-edge-metrics', { contentType: 'application/json', body: JSON.stringify({
    before, after: bounds, style: await menu.evaluate((element) => ({
      position: getComputedStyle(element).position, top: element.style.top, left: element.style.left,
      maxHeight: getComputedStyle(element).maxHeight, maxWidth: getComputedStyle(element).maxWidth,
      viewportHeight: window.visualViewport?.height, viewportWidth: window.visualViewport?.width,
    })),
  }) })
  expect(bounds.height).toBeGreaterThan(before.height)
  expect(bounds.y).toBeLessThan(before.y)
  expect(bounds.x).toBeGreaterThanOrEqual(8)
  expect(bounds.y).toBeGreaterThanOrEqual(8)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(382)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(492)
  expect(await menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await menu.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(menu).toBeVisible()
  expect(await menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => page.locator('html').evaluate((element) => element.scrollWidth)).toBe(390)
  // Settling initial layout must not disable later outside-scroll dismissal.
  await page.locator('.messages-viewport').evaluate((element) => element.dispatchEvent(new Event('scroll')))
  await expect(menu).toHaveCount(0)
})

test('long errors fit a reduced visual viewport with keyboard-sized height and nonzero offsets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('Long clipboard error. '.repeat(200)) } },
    })
  })
  await openFixture(page)
  await fixtureAction(page, 'incoming', url)
  await page.evaluate(() => {
    // Model keyboard/zoom geometry without an OS keyboard or mobile emulation.
    const viewport = window.visualViewport!
    for (const [name, value] of Object.entries({ height: 220, width: 320, offsetLeft: 40, offsetTop: 100 })) {
      Object.defineProperty(viewport, name, { configurable: true, value })
    }
  })
  const link = messages(page).last().getByRole('link', { name: url, exact: true })
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await settleLinkLayout(link)
  expect(await contextMenu(link, 359, 319)).toBe(true)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused()
  const copy = menu.getByRole('menuitem', { name: 'Copy link', exact: true })
  await copy.focus()
  await copy.press('Enter')
  await expect(menu.getByRole('alert')).toContainText('Long clipboard error.')
  await expect(copy).toBeFocused()
  const bounds = (await menu.boundingBox())!
  expect(bounds.height).toBeLessThanOrEqual(204)
  expect(bounds.x).toBeGreaterThanOrEqual(48)
  expect(bounds.y).toBeGreaterThanOrEqual(108)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(352)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(312)
  expect(await menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
})

test('native Share cancellation produces no error', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true, value: async () => { throw new DOMException('Cancelled', 'AbortError') },
    })
  })
  await openFixture(page)
  await fixtureAction(page, 'incoming', url)
  const link = messages(page).last().getByRole('link', { name: url, exact: true })
  await link.focus()
  await link.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await menu.getByRole('menuitem', { name: 'Share', exact: true }).click()
  await expect(menu.getByRole('alert')).toHaveCount(0)
})

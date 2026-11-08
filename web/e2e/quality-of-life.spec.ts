import { expect, test } from './fixtures'
import { fixtureAction, openFixture } from './interaction-fixture-support'
import { messages } from './support'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; this suite requires the in-memory UI fixture')

for (const width of [320, 390, 1280]) {
  test(`chat navigation moves focus without opening the composer keyboard (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    await openFixture(page)
    const region = page.getByRole('region', { name: 'Conversation with Bob', exact: true })
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await expect(region).toBeFocused()
    await expect(input).not.toBeFocused()
    await input.fill('Keep this local draft')
    await fixtureAction(page, 'incoming', 'A new message must not steal focus')
    await expect(messages(page).last()).toContainText('A new message must not steal focus')
    await expect(input).toBeFocused()
    if (width < 640) {
      await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
      const row = page.getByRole('button', { name: /Bob/ })
      await expect(row).toBeFocused()
      await row.press('Enter')
      await expect(region).toBeFocused()
      await expect(input).toHaveValue('Keep this local draft')
    } else {
      await fixtureAction(page, 'addChat')
      await page.getByRole('button', { name: /Other chat/ }).click()
      await expect(page.getByRole('region', { name: 'Conversation with Other chat', exact: true })).toBeFocused()
      await page.getByRole('button', { name: /Bob/ }).click()
      await expect(region).toBeFocused()
      await expect(input).toHaveValue('Keep this local draft')
    }
  })

  test(`menus keep their final keyboard actions inside a short viewport (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    await openFixture(page)
    const trigger = page.getByRole('button', { name: 'Conversation menu', exact: true })
    await trigger.press('ArrowDown')
    await page.setViewportSize({ width, height: 240 })
    const menu = page.getByRole('menu', { name: 'Conversation menu', exact: true })
    await expect(menu).toHaveCSS('overflow-y', 'auto')
    await expect.poll(async () => {
      const box = (await menu.boundingBox())!
      return { topInside: box.y >= 0, bottomInside: box.y + box.height <= 232 }
    }).toEqual({ topInside: true, bottomInside: true })
    await menu.getByRole('menuitemcheckbox', { name: 'Typing indicators', exact: true }).press('End')
    const last = menu.getByRole('menuitem', { name: 'Block', exact: true })
    await expect(last).toBeFocused()
    await expect(last).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: `test-results/qol-menu-fixed-${width}.png` })
    expect(await menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await last.press('Home')
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Typing indicators', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    const add = page.getByRole('button', { name: 'Add attachment', exact: true })
    await add.press('ArrowUp')
    const attachments = page.getByRole('menu', { name: 'Add attachment', exact: true })
    await expect(attachments.getByRole('menuitem', { name: 'Location', exact: true })).toBeFocused()
    await expect(attachments.getByRole('menuitem', { name: 'Location', exact: true })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await expect(add).toBeFocused()
  })

  test(`history retry keeps existing messages, draft text, and editing focus (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    await openFixture(page)
    await fixtureAction(page, 'incoming', 'Already visible history')
    await expect(messages(page)).toContainText(['Already visible history'])
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('Preserve the draft')
    await fixtureAction(page, 'failMessages', 1)
    await fixtureAction(page, 'incoming', 'Newly available history')
    await expect(page.getByRole('alert')).toContainText('Could not load messages.')
    await expect(messages(page)).toContainText(['Already visible history'])
    await fixtureAction(page, 'failMessages', 0)
    await fixtureAction(page, 'holdMessages')
    const retry = page.getByRole('button', { name: 'Retry loading messages', exact: true })
    await retry.click()
    await expect(retry).toBeDisabled()
    await expect(retry).toHaveAttribute('aria-busy', 'true')
    const loads = () => page.evaluate(() => (window as unknown as {
      interactionFixture: { qualityActivity: { historyLoads: number } }
    }).interactionFixture.qualityActivity.historyLoads)
    const pendingLoads = await loads()
    await retry.press('Enter')
    expect(await loads()).toBe(pendingLoads)
    await input.fill('Newer draft while retrying')
    await fixtureAction(page, 'releaseMessages')
    await expect(messages(page)).toContainText(['Already visible history', 'Newly available history'])
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(input).toHaveValue('Newer draft while retrying')
    await expect(input).toBeFocused()
  })

  test(`connection feedback remains visible in the selected conversation (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    await openFixture(page)
    const status = page.getByRole('status', { name: 'Conversation connection', exact: true })
    await expect(status).toBeHidden()
    await fixtureAction(page, 'connection', 'offline')
    await expect(status).toBeVisible()
    await expect(status).toHaveText('Offline')
    await expect(status).toBeInViewport({ ratio: 1 })
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('Editable while disconnected')
    await expect(input).toHaveValue('Editable while disconnected')
    await expect(page.getByRole('button', { name: 'Conversation menu', exact: true })).toBeInViewport({ ratio: 1 })
    await expect.poll(() => page.locator('html').evaluate((element) => element.scrollWidth)).toBe(width)
    await page.screenshot({ path: `test-results/qol-offline-fixed-${width}.png` })
    await fixtureAction(page, 'connection', 'connecting')
    await expect(status).toHaveText('Connecting…')
    await fixtureAction(page, 'connection', 'online')
    await expect(status).toBeHidden()
    await expect(input).toHaveValue('Editable while disconnected')
    await expect(input).toBeFocused()
  })

  test(`long file names and a failed download retain a usable keyboard retry (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    await openFixture(page)
    const filename = `${'long_report_name_'.repeat(8)}.txt`
    await fixtureAction(page, 'sampleAttachment', filename)
    const card = page.getByTestId('attachment')
    await expect(card).toBeVisible()
    await expect.poll(() => page.locator('html').evaluate((element) => element.scrollWidth)).toBe(width)
    await fixtureAction(page, 'failAttachment', 1)
    const download = card.getByRole('button', { name: 'Download', exact: true })
    await download.click()
    await expect(card.getByRole('alert')).toContainText('Fixture attachment is temporarily unavailable')
    await expect(download).toBeEnabled()
    await fixtureAction(page, 'failAttachment', 0)
    const downloaded = page.waitForEvent('download')
    await download.press('Enter')
    expect((await downloaded).suggestedFilename()).toBe(filename)
    await expect(card.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0)
  })
}

test('a later successful history refresh defeats an older failed request', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'holdMessages')
  await fixtureAction(page, 'incoming', 'Older pending history')
  await expect.poll(() => page.evaluate(() => (window as unknown as { interactionFixture: { historyPending(): boolean } }).interactionFixture.historyPending())).toBe(true)
  await fixtureAction(page, 'incoming', 'Newer successful history')
  await expect(messages(page)).toContainText(['Older pending history', 'Newer successful history'])
  await fixtureAction(page, 'releaseMessages', 1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(messages(page).last()).toContainText('Newer successful history')
})

test('a failed initial history load can retry without reopening the conversation', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', 'Saved history')
  await fixtureAction(page, 'failMessages', 1)
  await fixtureAction(page, 'restartUI')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(page.getByRole('alert')).toContainText('Could not load messages.')
  await fixtureAction(page, 'failMessages', 0)
  const retry = page.getByRole('button', { name: 'Retry loading messages', exact: true })
  await retry.focus()
  await retry.press('Enter')
  await expect(messages(page)).toContainText(['Saved history'])
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Conversation with Bob', exact: true })).toBeFocused()
})

test('menu bounds follow a modeled panned visual viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await page.addInitScript(() => Object.defineProperty(window, 'visualViewport', {
    configurable: true, value: Object.assign(new EventTarget(), { width: 320, height: 720, offsetTop: 0, scale: 1 }),
  }))
  await openFixture(page)
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click()
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 240, offsetTop: 140 })
    window.visualViewport!.dispatchEvent(new Event('resize'))
    window.visualViewport!.dispatchEvent(new Event('scroll'))
  })
  const menu = page.getByRole('menu', { name: 'Conversation menu', exact: true })
  await expect.poll(async () => {
    const box = (await menu.boundingBox())!
    return { topInside: box.y >= 140, bottomInside: box.y + box.height <= 372 }
  }).toEqual({ topInside: true, bottomInside: true })
  await menu.getByRole('menuitemcheckbox', { name: 'Typing indicators', exact: true }).press('End')
  await expect(menu.getByRole('menuitem', { name: 'Block', exact: true })).toBeFocused()
})


test('a held keyboard history retry restores conversation context without further interaction', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', 'Saved history')
  await fixtureAction(page, 'failMessages', 1)
  await fixtureAction(page, 'restartUI')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(page.getByRole('alert')).toContainText('Could not load messages.')
  await fixtureAction(page, 'failMessages', 0)
  await fixtureAction(page, 'holdMessages')
  const retry = page.getByRole('button', { name: 'Retry loading messages', exact: true })
  await retry.focus()
  await retry.press('Enter')
  await expect(retry).toHaveAttribute('aria-busy', 'true')
  await expect(retry).toBeDisabled()
  await expect(retry).toHaveCSS('opacity', '0.5')
  await expect(retry).toBeFocused()
  await fixtureAction(page, 'releaseMessages')
  await expect(messages(page)).toContainText(['Saved history'])
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Conversation with Bob', exact: true })).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).not.toBeFocused()
})

for (const width of [320, 1280]) {
  test(`call output menus preserve their anchored edge and stricter CSS cap (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 240 })
    await page.addInitScript(() => {
      Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { configurable: true, value: async () => undefined })
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        enumerateDevices: async () => Array.from({ length: 6 }, (_, index) => ({
          kind: 'audiooutput', deviceId: `output-${index + 1}`, label: `Speaker ${index + 1}`, groupId: '',
        })),
      } })
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/e2e/call-menu-fixture.html')
    const trigger = page.getByRole('button', { name: 'More call options', exact: true })
    const menu = page.getByRole('menu', { name: 'More call options', exact: true })
    for (const maximum of [undefined, 88]) {
      if (maximum !== undefined) await page.addStyleTag({ content: `.call-controls .menu-items { max-height: ${maximum}px }` })
      await page.evaluate(() => { (window as unknown as { callMenuFixture: { selectedOutput: string } }).callMenuFixture.selectedOutput = '' })
      await trigger.press('ArrowUp')
      await expect(menu.getByRole('menuitem')).toHaveCount(7)
      await expect.poll(async () => {
        const box = (await menu.boundingBox())!
        return { topInside: box.y >= 8, bottomInside: box.y + box.height <= 232 }
      }).toEqual({ topInside: true, bottomInside: true })
      if (maximum !== undefined) await expect(menu).toHaveCSS('max-height', `${maximum}px`)
      expect(await menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
      const last = menu.getByRole('menuitem', { name: 'Audio output: Speaker 6', exact: true })
      await expect(last).toBeFocused()
      await expect(last).toBeInViewport({ ratio: 1 })
      await last.press('Home')
      const first = menu.getByRole('menuitem', { name: 'Audio output: Default speaker', exact: true })
      await expect(first).toBeFocused()
      await expect(first).toBeInViewport({ ratio: 1 })
      await first.press('End')
      await expect(last).toBeFocused()
      await expect(last).toBeInViewport({ ratio: 1 })
      await last.press('Enter')
      await expect.poll(() => page.evaluate(() => (window as unknown as {
        callMenuFixture: { selectedOutput: string }
      }).callMenuFixture.selectedOutput)).toBe('output-6')
      await expect(menu).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
    expect(errors).toEqual([])
  })
}

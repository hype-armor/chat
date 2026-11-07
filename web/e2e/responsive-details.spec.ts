import { type Page, expect, test } from './fixtures'
import { expectDialogLayout, expectLayout, layoutViewports } from './layout'
import { conversationCall, conversationDetails } from './support'
import { fixtureAction } from './interaction-fixture-support'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; in-memory UI only, no call media or transport')

const title = 'Weekend trip with the climbing club'

async function open(page: Page, width: number, group = true) {
  await page.setViewportSize({ width, height: 800 })
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto(`/e2e/interactions-fixture.html?${new URLSearchParams({ title, group: group ? '1' : '0' })}`)
  await page.getByRole('button', { name: new RegExp(title) }).click()
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
  await fixtureAction(page, 'seed', 30)
  await expect(page.getByTestId('message')).toHaveCount(30)
}

for (const width of [768, 1024, 1100, 1280]) {
  test(`details preserve the conversation and composer at ${width}px`, async ({ page }, testInfo) => {
    await open(page, width)
    const chat = page.locator('.conversation')
    const before = (await chat.boundingBox())!
    const viewport = page.locator('.messages-viewport')
    await viewport.evaluate((element) => { element.scrollTop = 180 })
    const scroll = await viewport.evaluate((element) => element.scrollTop)
    const trigger = page.getByRole('button', { name: 'Group info', exact: true })
    await trigger.click()
    const details = conversationDetails(page)
    await expect(details).toBeVisible()
    const overlay = width < 1280
    if (overlay) {
      await expect(details).toHaveAttribute('role', 'dialog')
      await expect(details).toHaveAttribute('aria-modal', 'true')
      await expect(chat).toHaveAttribute('inert', '')
      expect((await chat.boundingBox())!.width).toBe(before.width)
      const panelBox = (await details.boundingBox())!
      expect(panelBox.width).toBeLessThan(before.width)
      expect(panelBox.x + panelBox.width).toBeCloseTo(before.x + before.width, 0)
      await expect(details.getByRole('button', { name: 'Close details' })).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(details.getByRole('button', { name: 'Leave group' })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(details.getByRole('button', { name: 'Close details' })).toBeFocused()
      await page.getByRole('button', { name: 'Settings', exact: true, includeHidden: true }).evaluate((element) => (element as HTMLElement).focus())
      await expect(details.getByRole('button', { name: 'Close details' })).toBeFocused()
    } else {
      expect((await chat.boundingBox())!.width).toBeGreaterThanOrEqual(28 * 16)
      await expect(chat).not.toHaveAttribute('inert', '')
    }
    const row = page.locator('.composer-row')
    const textarea = page.getByRole('textbox', { name: 'Message', exact: true, includeHidden: true })
    const inputBox = (await textarea.boundingBox())!
    const attachBox = (await row.locator('button[aria-label="Add attachment"]').boundingBox())!
    expect(Math.abs(inputBox.y + inputBox.height / 2 - attachBox.y - attachBox.height / 2)).toBeLessThan(1)
    expect(await viewport.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expectLayout(page, `details at ${width}px`, true)
    await testInfo.attach(`details-${width}.png`, { body: await page.screenshot(), contentType: 'image/png' })
    await page.keyboard.press('Escape')
    await expect(details).toBeHidden()
    await expect(trigger).toBeFocused()
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeCloseTo(scroll, 0)
    if (overlay) {
      await trigger.click()
      await page.locator('.details-scrim').click({ position: { x: 5, y: 200 } })
      await expect(details).toBeHidden()
      await expect(trigger).toBeFocused()
    }
  })
}

for (const group of [true, false]) {
  test(`320px ${group ? 'group' : 'direct'} header retains its title and call menu`, async ({ page }, testInfo) => {
    await open(page, 320, group)
    const heading = page.locator('.conversation-name')
    // Measure actual glyph geometry for the first 12 characters, not a guessed font width.
    expect(await heading.evaluate((element) => {
      const range = document.createRange()
      range.setStart(element.firstChild!, 0)
      range.setEnd(element.firstChild!, 12)
      return range.getBoundingClientRect().width <= element.clientWidth
    })).toBe(true)
    await expect(page.locator('.header-actions > button')).toHaveCount(0)
    await page.getByRole('button', { name: 'Conversation menu', exact: true }).click()
    const voice = page.getByRole('menuitem', { name: group ? 'Group voice call' : 'Voice call', exact: true })
    await expect(voice).toBeVisible()
    await expect(page.getByRole('menuitem', { name: group ? 'Group video call' : 'Video call', exact: true })).toBeVisible()
    await expectLayout(page, '320px call menu', true)
    await testInfo.attach(`header-${group ? 'group' : 'direct'}.png`, { body: await page.screenshot(), contentType: 'image/png' })
    await voice.click()
    await expect(page.getByRole('dialog', { name: group ? `Group call in ${title}` : `Call with ${title}`, exact: true })).toBeVisible()
    await expect(page.getByTestId('fixture-error')).toHaveCount(0)
  })
}

for (const { width, height, colorScheme } of layoutViewports) {
  test(`voice and video refusal dialogs remain reachable and fit at ${width}px`, async ({ page }) => {
    // Reproduce WebKit's unavailable encrypted-media path in every browser.
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'RTCRtpScriptTransform')
      if (typeof RTCRtpSender !== 'undefined') Reflect.deleteProperty(RTCRtpSender.prototype, 'createEncodedStreams')
    })
    await open(page, 1280, false)
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme })
    for (const kind of ['Voice', 'Video'] as const) {
      const headerCall = page.locator('.conversation-bar').getByRole('button', { name: `${kind} call`, exact: true })
      if (width === 320) await expect(headerCall).toBeHidden()
      else await expect(headerCall).toBeVisible()
      await conversationCall(page, kind)
      const dialog = page.getByRole('dialog', { name: `Call with ${title}`, exact: true })
      await expect(dialog).toContainText("can't encrypt call media")
      await expectDialogLayout(page, dialog, `${kind} refusal: ${width}×${height} ${colorScheme}`, true)
      await expect(dialog).toBeHidden()
    }
    await expect(page.getByTestId('fixture-error')).toHaveCount(0)
  })
}

test('group edit stays beside the name, with the count below; resize preserves focus handling', async ({ page }) => {
  await open(page, 1280)
  await page.getByRole('button', { name: 'Group info', exact: true }).click()
  const details = conversationDetails(page)
  const name = (await details.locator('.details-name strong').boundingBox())!
  const edit = details.getByRole('button', { name: 'Edit group name' })
  const button = (await edit.boundingBox())!
  expect(button.x).toBeGreaterThanOrEqual(name.x + name.width)
  expect(button.y).toBeLessThan(name.y + name.height)
  expect(button.y + button.height).toBeGreaterThan(name.y)
  const count = (await details.getByText('2 people', { exact: true }).boundingBox())!
  expect(count.y).toBeGreaterThanOrEqual(Math.max(name.y + name.height, button.y + button.height))
  await edit.click()
  await expect(details.getByRole('textbox', { name: 'Group name', exact: true })).toBeFocused()
  await details.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(edit).toBeFocused()
  // Resize an already open dock into an overlay, then into the phone view.
  for (const width of [1024, 320]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(details).toHaveAttribute('aria-modal', 'true')
    await expectLayout(page, `resized details at ${width}px`, true)
  }
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  await expect(page.getByRole('button', { name: 'Group info', exact: true })).toBeFocused()
})

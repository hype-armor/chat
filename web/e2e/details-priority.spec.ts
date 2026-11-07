import { type Page, expect, test } from './fixtures'
import { conversationDetails } from './support'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; UI focus only, no call media or transport')

const title = 'Weekend trip with the climbing club'
const noFrameEncryption = "This browser can't encrypt call media end to end, so calls are off. Use an up-to-date Chrome, Firefox or Safari."

async function openDetails(page: Page, disableEncryption = false) {
  if (disableEncryption) {
    // Remove capabilities only. Never polyfill encryption support in a UI test.
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'RTCRtpScriptTransform')
      if (typeof RTCRtpSender !== 'undefined') Reflect.deleteProperty(RTCRtpSender.prototype, 'createEncodedStreams')
    })
  }
  await page.setViewportSize({ width: 1024, height: 800 })
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto(`/e2e/interactions-fixture.html?${new URLSearchParams({ title, group: '1' })}`)
  await page.getByRole('button', { name: new RegExp(title) }).click()
  await page.getByRole('button', { name: 'Group info', exact: true }).click()
  await expect(conversationDetails(page)).toHaveAttribute('aria-modal', 'true')
  const supported = await page.evaluate(() => (window as unknown as {
    interactionFixture: { canEncryptCalls(): boolean }
  }).interactionFixture.canEncryptCalls())
  if (disableEncryption) expect(supported).toBe(false)
  return supported
}

async function incoming(page: Page, group: boolean) {
  await page.evaluate((group) => {
    (window as unknown as { interactionFixture: { incomingCall(group: boolean): void } }).interactionFixture.incomingCall(group)
  }, group)
}

async function callActions(page: Page) {
  return page.evaluate(() => (window as unknown as { interactionFixture: { callActions: string[] } }).interactionFixture.callActions)
}

for (const { action, disableEncryption } of [
  { action: 'Answer', disableEncryption: false },
  { action: 'Decline', disableEncryption: false },
  { action: 'Answer', disableEncryption: true },
]) {
  test(`an incoming direct call takes focus from details for keyboard ${action}${disableEncryption ? ' without frame encryption' : ''}`, async ({ page }) => {
    const supported = await openDetails(page, disableEncryption)
    await incoming(page, false)
    const call = page.getByRole('dialog', { name: `Incoming voice call from ${title}`, exact: true })
    await expect(call).toBeVisible()
    await expect(call.getByRole('button', { name: 'Decline', exact: true })).toBeFocused()
    const control = call.getByRole('button', { name: action, exact: true })
    await control.focus()
    await expect(control).toBeFocused()
    await expect(conversationDetails(page)).toBeHidden()
    await expect(page.locator('.sidebar')).not.toHaveAttribute('inert')
    await page.keyboard.press('Enter')
    if (action === 'Decline') await expect.poll(() => callActions(page)).toContain('decline')
    if (action === 'Answer' && supported) {
      await expect.poll(() => callActions(page)).toContain('answer')
      // The fixture holds ICE setup. The ongoing call controls must still work.
      const ongoing = page.getByRole('dialog', { name: `Call with ${title}`, exact: true })
      const mute = ongoing.getByRole('button', { name: 'Mute', exact: true })
      await mute.focus()
      await expect(mute).toBeFocused()
      // No media stream exists in this fixture, so Mute cannot change a track.
      await page.keyboard.press('Enter')
      await expect(mute).toBeFocused()
      const hangUp = ongoing.getByRole('button', { name: 'Hang up', exact: true })
      await hangUp.focus()
      await expect(hangUp).toBeFocused()
      await page.keyboard.press('Enter')
    }
    const ended = page.getByRole('dialog', { name: `Call with ${title}`, exact: true })
    if (action === 'Answer' && !supported) {
      // WebKit can reject setup before ICE. This is the required fail-closed path.
      await expect(ended.getByRole('status')).toHaveText(noFrameEncryption)
      expect(await callActions(page)).toEqual(['hangup'])
    }
    const close = ended.getByRole('button', { name: 'Close', exact: true })
    await close.focus()
    await expect(close).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(ended).toBeHidden()
    await expect(conversationDetails(page)).toBeHidden()
    await expect(page.getByTestId('fixture-error')).toHaveCount(0)
  })
}

for (const { action, disableEncryption } of [
  { action: 'Join', disableEncryption: false },
  { action: 'Not now', disableEncryption: false },
  { action: 'Join', disableEncryption: true },
]) {
  test(`an incoming group call takes focus from details for keyboard ${action}${disableEncryption ? ' without frame encryption' : ''}`, async ({ page }) => {
    const supported = await openDetails(page, disableEncryption)
    await incoming(page, true)
    const prompt = page.getByRole('dialog', { name: `Group voice call in ${title}`, exact: true })
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Not now', exact: true })).toBeFocused()
    const control = prompt.getByRole('button', { name: action, exact: true })
    await control.focus()
    await expect(control).toBeFocused()
    await expect(conversationDetails(page)).toBeHidden()
    await page.keyboard.press('Enter')
    await expect(prompt).toBeHidden()
    if (action === 'Join') {
      const call = page.getByRole('dialog', { name: `Group call in ${title}`, exact: true })
      if (supported) {
        await expect.poll(() => callActions(page)).toContain('join')
        const leave = call.getByRole('button', { name: 'Leave', exact: true })
        await leave.focus()
        await expect(leave).toBeFocused()
        await page.keyboard.press('Enter')
      } else {
        await expect(call.getByRole('status')).toHaveText(noFrameEncryption)
        expect(await callActions(page)).toEqual([])
      }
      const close = call.getByRole('button', { name: 'Close', exact: true })
      await close.focus()
      await expect(close).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(call).toBeHidden()
    }
    await expect(conversationDetails(page)).toBeHidden()
    await expect(page.getByTestId('fixture-error')).toHaveCount(0)
  })
}

test('the details modal covers newly mounted app regions and preserves prior inert state', async ({ page }) => {
  await openDetails(page)
  await page.evaluate(() => {
    const notice = document.createElement('button')
    notice.id = 'outside-notice'
    notice.textContent = 'A new app notice'
    notice.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:100'
    notice.addEventListener('click', () => { notice.dataset.clicked = 'true' })
    document.body.append(notice)
    const previouslyInert = document.createElement('button')
    previouslyInert.id = 'previously-inert'
    previouslyInert.inert = true
    document.body.append(previouslyInert)
  })
  const notice = page.locator('#outside-notice')
  await expect(notice).toHaveAttribute('inert', '')
  const box = (await notice.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(notice).not.toHaveAttribute('data-clicked')
  await page.keyboard.press('Escape')
  await expect(notice).not.toHaveAttribute('inert')
  await expect(page.locator('#previously-inert')).toHaveAttribute('inert', '')
  await notice.click()
  await expect(notice).toHaveAttribute('data-clicked', 'true')
})

test('the 1024px details modal blocks sidebar pointer actions and restores them after dismissal', async ({ page }) => {
  await openDetails(page)
  const sidebar = page.locator('.sidebar')
  const settings = sidebar.locator('button[aria-label="Settings"]')
  const compose = sidebar.locator('button[aria-label="New chat"]')
  for (const button of [settings, compose]) {
    const box = (await button.boundingBox())!
    // Use a real pointer event. Locator.click would wait for an inert target.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(sidebar.locator('.settings')).toHaveCount(0)
    await expect(sidebar.locator('[role="menu"]')).toHaveCount(0)
    await expect(conversationDetails(page)).toBeVisible()
  }
  await expect(sidebar).toHaveAttribute('inert', '')
  await page.keyboard.press('Escape')
  await expect(conversationDetails(page)).toBeHidden()
  await expect(sidebar).not.toHaveAttribute('inert')
  await settings.click()
  await expect(sidebar.getByRole('navigation', { name: 'Settings', exact: true })).toBeVisible()
})

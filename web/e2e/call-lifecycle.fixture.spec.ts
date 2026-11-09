import { test, expect, type Page } from './fixtures'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; in-memory UI only, no call media or transport')

const title = 'StrictMode call lifecycle'
const noEncryption = "This browser can't encrypt call media end to end, so calls are off. Use an up-to-date Chrome, Firefox or Safari."
type Fixture = { subscriberCount(): number; incomingCall(group: boolean): void; callActions: string[]; restartUI(): void; canEncryptCalls(): boolean }
async function open(page: Page, strict = true, group = false) {
  await page.goto(`/e2e/interactions-fixture.html?${new URLSearchParams({ title, strict: strict ? '1' : '0', group: group ? '1' : '0' })}`)
  await page.getByRole('button', { name: new RegExp(title) }).click()
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
}
async function subscriptions(page: Page) {
  return page.evaluate(() => (window as unknown as { interactionFixture: Fixture }).interactionFixture.subscriberCount())
}
test.beforeEach(async ({ page }, testInfo) => {
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  if (testInfo.title.includes('preserves the fail-closed guard')) {
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'RTCRtpScriptTransform')
      if (typeof RTCRtpSender !== 'undefined') Reflect.deleteProperty(RTCRtpSender.prototype, 'createEncodedStreams')
    })
  }
})

for (const group of [false, true]) {
  test(`StrictMode restores ${group ? 'group' : 'direct'} signalling and preserves the fail-closed guard`, async ({ page }) => {
    await open(page, true, group)
    await page.evaluate((group) => (window as unknown as { interactionFixture: Fixture }).interactionFixture.incomingCall(group), group)
    const incoming = page.getByRole('dialog', { name: group ? `Group voice call in ${title}` : `Incoming voice call from ${title}`, exact: true })
    await expect(incoming).toBeVisible()
    await incoming.getByRole('button', { name: group ? 'Join' : 'Answer', exact: true }).click()
    const call = page.getByRole('dialog', { name: group ? `Group call in ${title}` : `Call with ${title}`, exact: true })
    await expect(call.getByRole('status')).toHaveText(noEncryption)
    const actions = await page.evaluate(() => (window as unknown as { interactionFixture: Fixture }).interactionFixture.callActions)
    expect(actions).toEqual(group ? [] : ['hangup'])
    const close = call.getByRole('button', { name: 'Close', exact: true })
    await close.focus()
    await page.keyboard.press('Enter')
    await expect(call).toBeHidden()
    await expect(page.getByTestId('fixture-error')).toHaveCount(0)
  })
}

test('StrictMode retains mutual exclusion between the actual direct and group controllers', async ({ page }) => {
  await open(page, true, true)
  const supported = await page.evaluate(() => (window as unknown as { interactionFixture: Fixture }).interactionFixture.canEncryptCalls())
  test.skip(!supported, 'This test requires the real encrypted-media capability; refusal tests cover unsupported browsers.')
  // The fixture holds signalling or ICE. It does not bypass media encryption or prove transport.
  await page.getByRole('button', { name: 'Group voice call', exact: true }).click()
  const group = page.getByRole('dialog', { name: `Group call in ${title}`, exact: true })
  await expect(group.getByRole('status')).toHaveText('Joining…')
  await page.evaluate(() => (window as unknown as { interactionFixture: Fixture }).interactionFixture.incomingCall(false))
  await expect.poll(() => page.evaluate(() => (window as unknown as { interactionFixture: Fixture }).interactionFixture.callActions)).toContain('busy')
  await expect(page.getByRole('dialog', { name: `Incoming voice call from ${title}`, exact: true })).toHaveCount(0)
  await group.getByRole('button', { name: 'Leave', exact: true }).click()
  await group.getByRole('button', { name: 'Close', exact: true }).click()

  await page.evaluate(() => (window as unknown as { interactionFixture: Fixture }).interactionFixture.incomingCall(false))
  const prompt = page.getByRole('dialog', { name: `Incoming voice call from ${title}`, exact: true })
  await prompt.getByRole('button', { name: 'Answer', exact: true }).click()
  const direct = page.getByRole('dialog', { name: `Call with ${title}`, exact: true })
  await expect(direct).toBeVisible()
  await page.evaluate(() => (window as unknown as { interactionFixture: Fixture }).interactionFixture.incomingCall(true))
  await expect(page.getByRole('dialog', { name: `Group voice call in ${title}`, exact: true })).toHaveCount(0)
  await direct.getByRole('button', { name: 'Hang up', exact: true }).click()
  await direct.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByTestId('fixture-error')).toHaveCount(0)
})

test('StrictMode and UI restarts retain no discarded-controller subscriptions', async ({ page }) => {
  // The fixture has 2 controller subscriptions. Selecting a conversation adds
  // 1 history subscription and 1 typing subscription. Composer visibility alone
  // does not prove that React has run these passive effects.
  const controllers = 2
  const selected = controllers + 2
  await open(page, false)
  await expect.poll(() => subscriptions(page)).toBe(selected)
  const normal = await subscriptions(page)
  await open(page, true)
  await expect.poll(() => subscriptions(page)).toBe(normal)
  for (let restart = 0; restart < 2; restart++) {
    await page.evaluate(() => (window as unknown as { interactionFixture: Fixture }).interactionFixture.restartUI())
    // restartUI changes Chat's key and clears its selected conversation. Wait
    // for the actual remount, not an old count sampled before React commits.
    const composer = page.getByRole('textbox', { name: 'Message', exact: true })
    await expect(composer).toHaveCount(0)
    await expect.poll(() => subscriptions(page)).toBe(controllers)
    await page.getByRole('button', { name: new RegExp(title) }).click()
    await expect(composer).toBeVisible()
    await expect.poll(() => subscriptions(page)).toBe(normal)
  }
  await expect(page.getByTestId('fixture-error')).toHaveCount(0)
})

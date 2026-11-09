import { expect, test, type Page } from './fixtures'
import { fixtureAction, openFixture } from './interaction-fixture-support'

// These cases test UI state only. They use no server, database, or location service.
test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts with the in-memory UI fixture')

const viewport = (page: Page) => page.locator('.messages-viewport')
const gap = (page: Page) => viewport(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
const position = (page: Page) => page.getByTestId('message').nth(20).evaluate((el) =>
  el.getBoundingClientRect().top - el.closest('.messages-viewport')!.getBoundingClientRect().top)

async function selectChat(page: Page, title: RegExp) {
  const back = page.getByRole('button', { name: 'Back to conversations' })
  if (await back.isVisible()) await back.click()
  await page.getByRole('navigation', { name: 'Conversations', exact: true }).getByRole('button', { name: title }).click()
}

async function readHistory(page: Page) {
  await fixtureAction(page, 'seed', 60)
  await expect(page.getByTestId('message')).toHaveCount(60)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  await viewport(page).evaluate((el) => {
    const message = el.querySelectorAll('[data-testid="message"]')[20]
    el.scrollTop += message.getBoundingClientRect().top - el.getBoundingClientRect().top - 18
  })
  await expect(page.getByRole('button', { name: 'Scroll to bottom', exact: true })).toBeVisible()
  return position(page)
}

for (const width of [390, 1280]) {
  test(`restores history across navigation and keeps a bottom-right chevron (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await openFixture(page)
    const original = await readHistory(page)
    const chevron = page.locator('.issue132-scroll-bottom')
    const box = await chevron.boundingBox()
    const area = await viewport(page).boundingBox()
    expect(box).not.toBeNull()
    expect(area).not.toBeNull()
    expect(Math.abs(area!.x + area!.width - box!.x - box!.width)).toBeLessThan(25)
    expect(Math.abs(area!.y + area!.height - box!.y - box!.height)).toBeLessThan(25)

    await fixtureAction(page, 'addChat')
    await selectChat(page, /Other chat/)
    await expect(page.getByRole('region', { name: 'Conversation with Other chat', exact: true })).toBeVisible()
    await expect(page.getByTestId('message')).toHaveCount(0)
    await fixtureAction(page, 'incoming', 'Received while reading another conversation')
    await selectChat(page, /Bob/)
    await expect(page.getByTestId('message')).toHaveCount(61)
    await expect.poll(() => position(page)).toBeCloseTo(original, 0)
    await expect(chevron).toBeVisible()
    await expect(chevron).toHaveAccessibleName('↓ New messages')

    await chevron.click()
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
    await expect(chevron).toHaveCount(0)
    await selectChat(page, /Other chat/)
    await fixtureAction(page, 'incoming', 'Received while the saved position was bottom')
    await selectChat(page, /Bob/)
    await expect(page.getByTestId('message')).toHaveCount(62)
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)

    // A small gap still needs a chevron, although auto-follow uses an 80px threshold.
    await viewport(page).evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 30 })
    await expect(chevron).toBeVisible()
    await chevron.focus()
    await chevron.press('Enter')
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
    await expect(chevron).toHaveCount(0)

    await readHistory(page)
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('My send returns to the bottom')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByTestId('message').last()).toContainText('My send returns to the bottom')
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  })
}

test('recipient name opens the settings menu and details restore focus to that menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto('/e2e/interactions-fixture.html?group=1')
  await page.getByRole('navigation', { name: 'Conversations', exact: true }).getByRole('button', { name: /Bob/ }).click()
  const trigger = page.getByRole('button', { name: 'Conversation menu', exact: true })
  await expect(trigger).toContainText('Bob')
  await expect(trigger).toHaveAccessibleDescription(/Bob.*2 people/)
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
  await trigger.focus()
  await trigger.press('ArrowDown')
  const menu = page.getByRole('menu', { name: 'Conversation menu', exact: true })
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Typing indicators' })).toBeFocused()
  await menu.getByRole('menuitem', { name: 'Group info', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'Conversation details', exact: true })
  await expect(details).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('opening a conversation does not request location or invent an unavailable city', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { issue132LocationRequests: 0 })
    const record = () => { (window as unknown as { issue132LocationRequests: number }).issue132LocationRequests++ }
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: record, watchPosition: record, clearWatch() {} } })
  })
  await openFixture(page)
  await fixtureAction(page, 'incoming', 'No structured city or state is available')
  const header = page.locator('.conversation-bar')
  await expect(header.getByRole('heading', { name: 'Bob', exact: true })).toBeVisible()
  await expect(header).not.toContainText(/latitude|longitude|city unavailable/i)
  expect(await page.evaluate(() => (window as unknown as { issue132LocationRequests: number }).issue132LocationRequests)).toBe(0)
})

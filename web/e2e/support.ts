// Helpers for the messaging end-to-end tests (real chat-server).
import { type Browser, type Page, expect } from '@playwright/test'

/** A fresh username for each test run, e.g. `u4821937.55`. */
export function randomUsername(): string {
  const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0')
  return `u${digits(7)}.${digits(2)}`
}

/** Signs up in a new browser context (the e2e server allows open sign-up). */
export async function signUp(browser: Browser, name: string, username: string, invite?: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.goto(invite ? `/#invite=${invite}` : '/')
  // Username first: leaving the name field fills in a suggestion.
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Sign up' }).click()
  await expect(page.getByRole('status')).toHaveText('Connected')
  return page
}

export const messages = (page: Page) => page.getByTestId('message')

/** Opens a compose panel from the sidebar menu. */
export async function compose(page: Page, action: 'New chat' | 'New group') {
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

/** Submits a 1:1 chat (leaves any validation error visible to the caller). */
export async function startChat(page: Page, username: string) {
  await compose(page, 'New chat')
  await page.getByLabel("Contact's username").fill(username)
  await page.getByRole('button', { name: 'Start chat', exact: true }).click()
}

/** Creates and opens a group. */
export async function createGroup(page: Page, name: string, usernames: string[]) {
  await compose(page, 'New group')
  const panel = page.getByRole('region', { name: 'New group', exact: true })
  await panel.getByLabel('Group name', { exact: true }).fill(name)
  await panel.getByLabel("Members' usernames").fill(usernames.join('\n'))
  await panel.getByRole('button', { name: 'Create group', exact: true }).click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}

/** Selects a secondary action from the conversation header. */
export async function conversationAction(page: Page, action: string) {
  await closeDetails(page)
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

export const conversationDetails = (page: Page) => page.getByRole('complementary', { name: 'Conversation details' })

export async function closeDetails(page: Page) {
  const panel = conversationDetails(page)
  if (await panel.isVisible()) {
    await panel.getByRole('button', { name: /^(Close details|Back to conversation)$/ }).click()
    await expect(panel).toBeHidden()
  }
}

export async function memberAction(page: Page, name: string, action: 'Verify' | 'Make admin' | 'Remove') {
  const panel = conversationDetails(page)
  await panel.getByRole('button', { name: `Actions for ${name}`, exact: true }).click()
  await panel.getByRole('menuitem', { name: action, exact: true }).click()
}

/** Opens the Settings screen (backup, devices, privacy…). */
export async function openSettings(page: Page) {
  const button = page.getByRole('button', { name: 'Settings' })
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
}

/** Opens a Settings row without collapsing it if it is already open. */
export async function openSetting(page: Page, name: string) {
  await openSettings(page)
  const summary = page.getByRole('navigation', { name: 'Settings', exact: true })
    .locator('summary').filter({ hasText: name })
  await expect(summary).toHaveCount(1)
  const section = summary.locator('..')
  if ((await section.getAttribute('open')) === null) await summary.click()
  await expect(section).toHaveAttribute('open', '')
  return section
}

/** Back from Settings to the conversation list. */
export async function closeSettings(page: Page) {
  const button = page.getByRole('button', { name: 'Settings' })
  if ((await button.getAttribute('aria-pressed')) === 'true') await button.click()
}

/** Links a new browser to the account signed in on `page` by typed code. */
export async function linkDevice(browser: Browser, page: Page): Promise<Page> {
  const laptop = await (await browser.newContext()).newPage()
  await laptop.goto('/')
  await laptop.getByRole('button', { name: /Link this one/ }).click()
  const code = (await laptop.getByTestId('link-code').textContent())!.trim()
  await openSetting(page, 'Linked devices')
  await page.getByRole('button', { name: 'Link a new device' }).click()
  await page.getByLabel('Or type the code shown on the new device').fill(code)
  await expect(page.getByText('The new device will be able to read every message')).toBeVisible()
  await page.getByRole('button', { name: 'Link device' }).click()
  await expect(page.getByRole('button', { name: 'Link a new device' })).toBeVisible({ timeout: 30_000 })
  await expect(laptop.getByRole('status')).toHaveText('Connected')
  await closeSettings(page)
  return laptop
}

/** Opens a conversation, accepting it if it arrived as a message request. */
export async function openChat(page: Page, name: RegExp) {
  const row = page.getByRole('button', { name, includeHidden: true })
  await expect(row).toBeAttached()
  if (!(await row.isVisible())) await page.locator('.message-requests > summary').click()
  await page.getByRole('button', { name }).click()
  const accept = page.getByRole('button', { name: 'Accept' })
  if (await accept.isVisible()) await accept.click()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
}

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
  await expect(page.getByRole('status')).toHaveText('online')
  return page
}

export const messages = (page: Page) => page.getByTestId('message')

/** Opens the Settings screen (backup, devices, privacy…). */
export async function openSettings(page: Page) {
  const button = page.getByRole('button', { name: 'Settings' })
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
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
  await openSettings(page)
  await page.getByText('Linked devices').click()
  await page.getByRole('button', { name: 'Link a new device' }).click()
  await page.getByLabel('Or type the code shown on the new device').fill(code)
  await expect(page.getByText('The new device will be able to read every message')).toBeVisible()
  await page.getByRole('button', { name: 'Link device' }).click()
  await expect(page.getByRole('button', { name: 'Link a new device' })).toBeVisible({ timeout: 30_000 })
  await expect(laptop.getByRole('status')).toHaveText('online')
  await closeSettings(page)
  return laptop
}

/** Opens a conversation, accepting it if it arrived as a message request. */
export async function openChat(page: Page, name: RegExp) {
  await page.getByRole('button', { name }).click()
  const accept = page.getByRole('button', { name: 'Accept' })
  if (await accept.isVisible()) await accept.click()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
}

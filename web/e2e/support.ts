// Helpers for the messaging end-to-end tests (real chat-server).
import { readFile } from 'node:fs/promises'
import { type Browser, type Page, expect } from '@playwright/test'

const SERVER_LOG = new URL('../../target/e2e-server.log', import.meta.url)

export function randomPhone(): string {
  return `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
}

/** Reads the code the development log sender wrote for `phone`. */
export async function verificationCode(phone: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const lines = (await readFile(SERVER_LOG, 'utf8').catch(() => '')).split('\n')
    for (const line of lines.reverse()) {
      if (!line.includes(phone)) continue
      const fields = JSON.parse(line).fields
      if (fields?.phone === phone && fields.code) return fields.code
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no verification code logged for ${phone}`)
}

export async function signUp(browser: Browser, name: string, phone: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/')
  await page.getByLabel('Your name').fill(name)
  await page.getByLabel('Phone number').fill(phone)
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('Verification code').fill(await verificationCode(phone))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('status')).toHaveText('online')
  return page
}

export const messages = (page: Page) => page.getByTestId('message')

/** Links a new browser to the account signed in on `page` by typed code. */
export async function linkDevice(browser: Browser, page: Page): Promise<Page> {
  const laptop = await (await browser.newContext()).newPage()
  await laptop.goto('/')
  await laptop.getByRole('button', { name: /Link this one/ }).click()
  const code = (await laptop.getByTestId('link-code').textContent())!.trim()
  await page.getByText('Linked devices').click()
  await page.getByRole('button', { name: 'Link a new device' }).click()
  await page.getByLabel('Or type the code shown on the new device').fill(code)
  await expect(page.getByText('The new device will be able to read every message')).toBeVisible()
  await page.getByRole('button', { name: 'Link device' }).click()
  await expect(page.getByRole('button', { name: 'Link a new device' })).toBeVisible({ timeout: 30_000 })
  await expect(laptop.getByRole('status')).toHaveText('online')
  return laptop
}

/** Opens a conversation, accepting it if it arrived as a message request. */
export async function openChat(page: Page, name: RegExp) {
  await page.getByRole('button', { name }).click()
  const accept = page.getByRole('button', { name: 'Accept' })
  if (await accept.isVisible()) await accept.click()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
}

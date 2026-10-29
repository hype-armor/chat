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

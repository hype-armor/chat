import { readFile } from 'node:fs/promises'
import { type Browser, type Page, expect, test } from '@playwright/test'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

const SERVER_LOG = new URL('../../target/e2e-server.log', import.meta.url)

function randomPhone(): string {
  return `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
}

/** Reads the code the development log sender wrote for `phone`. */
async function verificationCode(phone: string): Promise<string> {
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

async function signUp(browser: Browser, name: string, phone: string): Promise<Page> {
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

const messages = (page: Page) => page.getByTestId('message')

test('two people exchange encrypted messages, and history survives a reload', async ({ browser }) => {
  const alicePhone = randomPhone()
  const bobPhone = randomPhone()
  const alice = await signUp(browser, 'Alice', alicePhone)
  const bob = await signUp(browser, 'Bob', bobPhone)

  await alice.getByLabel("Contact's phone number").fill(bobPhone)
  await alice.getByRole('button', { name: 'Start chat' }).click()
  await alice.getByLabel('Message').fill('Hello Bob')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(messages(alice).filter({ hasText: 'Hello Bob' })).toContainText('Sent')
  // Bob's profile arrives once he joins, replacing the phone number.
  await expect(alice.getByRole('heading', { name: 'Bob' })).toBeVisible()

  await bob.getByRole('button', { name: /Alice/ }).click()
  await expect(messages(bob)).toHaveText([/Hello Bob/])
  await bob.getByLabel('Message').fill('Hi Alice')
  await bob.getByRole('button', { name: 'Send' }).click()
  await expect(messages(alice)).toHaveText([/Hello Bob/, /Hi Alice/])

  // Keys and history are restored from encrypted storage after a reload.
  await bob.reload()
  await expect(bob.getByRole('status')).toHaveText('online')
  await bob.getByRole('button', { name: /Alice/ }).click()
  await expect(messages(bob)).toHaveText([/Hello Bob/, /Hi Alice/])
  await alice.getByLabel('Message').fill('Still there?')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(messages(bob)).toHaveText([/Hello Bob/, /Hi Alice/, /Still there\?/])
})

test('unknown numbers are reported', async ({ browser }) => {
  const page = await signUp(browser, 'Carol', randomPhone())
  await page.getByLabel("Contact's phone number").fill(randomPhone())
  await page.getByRole('button', { name: 'Start chat' }).click()
  await expect(page.getByRole('alert')).toHaveText('no account for that number')
})

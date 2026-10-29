import { expect, test } from '@playwright/test'
import { messages, openChat, randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('an invite link signs up one person, who can then be messaged (ADR-0021)', async ({ browser }) => {
  const alice = await signUp(browser, 'Alice', randomUsername())
  await alice.getByText('Invite someone').click()
  await alice.getByRole('button', { name: 'Create invite link' }).click()
  const link = (await alice.getByTestId('invite-link').textContent())!.trim()
  expect(link).toMatch(/\/#invite=[A-Za-z0-9_-]{22}$/)
  const code = link.split('#invite=')[1]

  // The link fills in the invite; signing up uses it.
  const bobUsername = randomUsername()
  const bob = await signUp(browser, 'Bob', bobUsername, code)
  await expect(bob).toHaveURL(/\/$/)

  // It works once only.
  const carol = await (await browser.newContext()).newPage()
  await carol.goto(`/#invite=${code}`)
  await expect(carol.getByLabel('Invite code')).toHaveValue(code)
  await carol.getByLabel('Username').fill(randomUsername())
  await carol.getByLabel('Your name').fill('Carol')
  await carol.getByRole('button', { name: 'Sign up' }).click()
  await expect(carol.getByRole('alert')).toContainText('not valid')

  // Alice adds Bob by his username.
  await alice.getByLabel("Contact's username").fill(bobUsername)
  await alice.getByRole('button', { name: 'Start chat' }).click()
  await alice.getByLabel('Message', { exact: true }).fill('Welcome!')
  await alice.getByRole('button', { name: 'Send' }).click()
  await openChat(bob, /Alice/)
  await expect(messages(bob)).toHaveText([/Welcome!/])
})

test('suggests a username from the name', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Your name').fill('Dana Lee')
  await page.getByLabel('Your name').blur()
  await expect(page.getByLabel('Username')).toHaveValue(/^danalee\.\d{2}$/)
})

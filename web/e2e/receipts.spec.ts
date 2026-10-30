import { expect, test } from '@playwright/test'
import { closeSettings, messages, openChat, openSettings, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('sent, delivered and read, with read receipts that can be turned off (FR-MSG-5)', async ({ browser }) => {
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobUsername)
  const status = (text: string, name: string) => messages(alice).filter({ hasText: text }).getByRole('img', { name, exact: true })
  const send = async (text: string) => {
    await alice.getByLabel('Message', { exact: true }).fill(text)
    await alice.getByRole('button', { name: 'Send' }).click()
  }

  await startChat(alice, bobUsername)
  await send('First')
  // A message request sends no receipts: Alice can't tell Bob has it.
  await expect(bob.getByRole('button', { name: /Alice.*1 unread/, includeHidden: true })).toBeAttached()
  await expect(status('First', 'Sent')).toBeVisible()

  // Accepting with the chat open: delivered and read.
  await openChat(bob, /Alice/)
  await expect(status('First', 'Read')).toBeVisible()

  // Bob closes the chat (a reload opens none): delivered only, unread for him.
  await bob.reload()
  await expect(bob.getByRole('status')).toHaveText('Connected')
  await send('Second')
  await expect(status('Second', 'Delivered')).toBeVisible()
  await expect(status('First', 'Read')).toBeVisible()
  await expect(messages(alice).filter({ hasText: 'First' }).locator('.message-status')).toHaveCount(0)
  await expect(bob.getByRole('button', { name: /Alice.*1 unread/ })).toBeVisible()
  await bob.getByRole('button', { name: /Alice/ }).click()
  await expect(status('Second', 'Read')).toBeVisible()

  // With read receipts off, Alice only sees delivery.
  await bob.reload()
  await expect(bob.getByRole('status')).toHaveText('Connected')
  await openSettings(bob)
  await bob.getByText('Privacy').click()
  await bob.getByLabel('Send read receipts').uncheck()
  await send('Third')
  await expect(status('Third', 'Delivered')).toBeVisible()
  await closeSettings(bob)
  await bob.getByRole('button', { name: /Alice/ }).click()
  await expect(messages(bob)).toHaveText([/First/, /Second/, /Third/])
  await bob.waitForTimeout(1000)
  await expect(status('Third', 'Delivered')).toBeVisible()
})

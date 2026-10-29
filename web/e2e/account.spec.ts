import { expect, test } from '@playwright/test'
import { messages, openChat, randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('deleting an account signs out and frees the username (FR-ID-9)', async ({ browser }) => {
  const aliceUsername = randomUsername()
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', aliceUsername)
  const bob = await signUp(browser, 'Bob', bobUsername)
  await alice.getByLabel("Contact's username").fill(bobUsername)
  await alice.getByRole('button', { name: 'Start chat' }).click()
  await alice.getByLabel('Message', { exact: true }).fill('Bye soon')
  await alice.getByRole('button', { name: 'Send' }).click()
  await openChat(bob, /Alice/)
  await expect(messages(bob)).toHaveText([/Bye soon/])

  await alice.getByText('Delete account').click()
  await alice.getByLabel('Type your username to confirm').fill('someone.else.00')
  await alice.getByRole('button', { name: 'Delete my account' }).click()
  await expect(alice.getByRole('alert')).toContainText("isn't this account's username")
  await alice.getByLabel('Type your username to confirm').fill(aliceUsername)
  await alice.getByRole('button', { name: 'Delete my account' }).click()
  await expect(alice.getByText('Your account was deleted.')).toBeVisible()
  await expect(alice.getByLabel('Username')).toBeVisible()

  // Alice left the chat first, so Bob's side no longer includes her.
  await expect(bob.getByRole('heading', { name: 'Just you' })).toBeVisible({ timeout: 15_000 })

  // The username is free again, for a new account with no history.
  await alice.getByLabel('Username').fill(aliceUsername)
  await alice.getByLabel('Your name').fill('Alice again')
  await alice.getByRole('button', { name: 'Sign up' }).click()
  await expect(alice.getByRole('status')).toHaveText('online')
  await expect(alice.getByText('No conversations yet.')).toBeVisible()
})

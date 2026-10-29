import { expect, test } from '@playwright/test'
import { messages, openChat, randomPhone, signUp, verificationCode } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('deleting an account signs out and frees the number (FR-ID-9)', async ({ browser }) => {
  const alicePhone = randomPhone()
  const bobPhone = randomPhone()
  const alice = await signUp(browser, 'Alice', alicePhone)
  const firstCode = await verificationCode(alicePhone)
  const bob = await signUp(browser, 'Bob', bobPhone)
  await alice.getByLabel("Contact's phone number").fill(bobPhone)
  await alice.getByRole('button', { name: 'Start chat' }).click()
  await alice.getByLabel('Message', { exact: true }).fill('Bye soon')
  await alice.getByRole('button', { name: 'Send' }).click()
  await openChat(bob, /Alice/)
  await expect(messages(bob)).toHaveText([/Bye soon/])

  await alice.getByText('Delete account').click()
  await alice.getByLabel('Type your phone number to confirm').fill('+15550000000')
  await alice.getByRole('button', { name: 'Delete my account' }).click()
  await expect(alice.getByRole('alert')).toContainText("isn't this account's phone number")
  await alice.getByLabel('Type your phone number to confirm').fill(alicePhone)
  await alice.getByRole('button', { name: 'Delete my account' }).click()
  await expect(alice.getByText('Your account was deleted.')).toBeVisible()
  await expect(alice.getByLabel('Phone number')).toBeVisible()

  // Alice left the chat first, so Bob's side no longer includes her.
  await expect(bob.getByRole('heading', { name: 'Just you' })).toBeVisible({ timeout: 15_000 })

  // The number can sign up again, as a new account with no history.
  await alice.getByLabel('Your name').fill('Alice again')
  await alice.getByLabel('Phone number').fill(alicePhone)
  await alice.getByRole('button', { name: 'Send code' }).click()
  await alice.getByLabel('Verification code').fill(await verificationCode(alicePhone, firstCode))
  await alice.getByRole('button', { name: 'Verify' }).click()
  await expect(alice.getByRole('status')).toHaveText('online')
  await expect(alice.getByText('No conversations yet.')).toBeVisible()
})

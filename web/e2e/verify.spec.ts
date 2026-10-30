import { expect, test } from '@playwright/test'
import { conversationAction, linkDevice, messages, openChat, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('safety numbers match, and a new device of a verified contact is flagged (ADR-0020)', async ({ browser }) => {
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobUsername)
  await startChat(alice, bobUsername)
  await alice.getByLabel('Message').fill('Hi Bob')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(alice.getByRole('heading', { name: 'Bob' })).toBeVisible()
  await openChat(bob, /Alice/)
  await expect(messages(bob)).toHaveText([/Hi Bob/])

  // Both see the same 60 digits.
  await conversationAction(alice, 'Verify safety number')
  await conversationAction(bob, 'Verify safety number')
  const number = (await alice.getByTestId('safety-number').textContent())!.trim()
  expect(number).toMatch(/^(\d{5} ){11}\d{5}$/)
  await expect(bob.getByTestId('safety-number')).toHaveText(number)
  await alice.getByRole('button', { name: 'Mark as verified' }).click()
  await expect(alice.locator('.conversation header .badge')).toHaveText('Verified')

  // Bob links a laptop: Alice is told, and her verification no longer holds.
  const laptop = await linkDevice(browser, bob)
  await expect(alice.getByTestId('notice')).toHaveText("Bob's safety number changed: a device was added.", {
    timeout: 15_000,
  })
  await expect(alice.locator('.conversation header .badge')).toHaveText('Changed')
  await expect(alice.getByRole('note')).toContainText('safety number changed since you verified it')
  await conversationAction(alice, 'Verify safety number')
  await expect(alice.getByTestId('safety-number')).not.toHaveText(number)

  // Bob approved the laptop himself, so neither of his devices raises an alert.
  await expect(bob.getByRole('alert')).toHaveCount(0)
  await expect(laptop.getByRole('alert')).toHaveCount(0)
})

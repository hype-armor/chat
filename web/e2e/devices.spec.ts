import { expect, test } from '@playwright/test'
import { linkDevice, messages, openChat, randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('linking a second device by code, then removing it (ADR-0019)', async ({ browser }) => {
  const aliceUsername = randomUsername()
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', aliceUsername)
  const bob = await signUp(browser, 'Bob', bobUsername)
  await alice.getByLabel("Contact's username").fill(bobUsername)
  await alice.getByRole('button', { name: 'Start chat' }).click()
  await alice.getByLabel('Message').fill('Before linking')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(alice.getByRole('heading', { name: 'Bob' })).toBeVisible()

  // The new device shows a code; the first device approves it.
  const laptop = await linkDevice(browser, alice)
  await expect(alice.getByRole('list', { name: 'Devices' }).getByRole('listitem')).toHaveCount(2)

  // The laptop is signed in as Alice, in her conversation with Bob.
  await expect(laptop.getByText(aliceUsername)).toBeVisible()
  await expect(laptop.getByRole('button', { name: /Bob/ })).toBeVisible({ timeout: 15_000 })
  // Her name arrives from the first device over the self conversation.
  await expect(laptop.locator('header strong')).toHaveText('Alice')

  // No history moves, but new messages reach both of Alice's devices.
  await openChat(bob, /Alice/)
  await bob.getByLabel('Message').fill('Hello both')
  await bob.getByRole('button', { name: 'Send' }).click()
  await laptop.getByRole('button', { name: /Bob/ }).click()
  await expect(messages(laptop)).toHaveText([/Hello both/])

  // What Alice sends from one device shows as hers on the other.
  await alice.getByLabel('Message').fill('From the username')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(messages(laptop).filter({ hasText: 'From the username' })).toHaveClass(/mine/)
  await laptop.getByLabel('Message').fill('From the laptop')
  await laptop.getByRole('button', { name: 'Send' }).click()
  await expect(messages(bob).filter({ hasText: 'From the laptop' })).toHaveClass(/theirs/)
  await expect(messages(alice).filter({ hasText: 'From the laptop' })).toHaveClass(/mine/)

  // Removing the laptop signs it out; Alice and Bob carry on.
  await alice.getByRole('button', { name: 'Remove device 2' }).click()
  await expect(laptop.getByText(/This device is no longer signed in/)).toBeVisible({ timeout: 15_000 })
  await expect(alice.getByRole('list', { name: 'Devices' }).getByRole('listitem')).toHaveCount(1)
  await bob.getByLabel('Message').fill('Just you now')
  await bob.getByRole('button', { name: 'Send' }).click()
  await expect(messages(bob).filter({ hasText: 'Just you now' })).toContainText(/Sent|Delivered|Read/)
  await expect(messages(alice).filter({ hasText: 'Just you now' })).toBeVisible()
})

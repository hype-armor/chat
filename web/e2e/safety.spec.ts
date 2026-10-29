import { expect, test } from '@playwright/test'
import { messages, openChat, randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('reporting and blocking someone, then unblocking them (FR-ID-8)', async ({ browser }) => {
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobUsername)
  await alice.getByLabel("Contact's username").fill(bobUsername)
  await alice.getByRole('button', { name: 'Start chat' }).click()
  await alice.getByLabel('Message').fill('Buy cheap watches')
  await alice.getByRole('button', { name: 'Send' }).click()
  // Bob accepts the chat, then thinks better of it.
  await openChat(bob, /Alice/)
  await expect(messages(bob)).toHaveText([/Buy cheap watches/])

  // Bob reports Alice with her messages and blocks her.
  await bob.getByRole('button', { name: 'Report' }).click()
  await bob.getByLabel('Spam or scam').check()
  await expect(bob.getByLabel('Also block Alice')).toBeChecked()
  await bob.getByRole('button', { name: 'Send report' }).click()
  await expect(bob.getByText('Report sent. Thank you.')).toBeVisible()
  await expect(bob.getByRole('note')).toContainText('You blocked Alice')
  await expect(bob.getByLabel('Message')).toBeHidden()

  // Her messages no longer show up.
  await alice.getByLabel('Message').fill('Last chance!')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(messages(alice).filter({ hasText: 'Last chance!' })).toContainText('Sent')
  await bob.getByText('Blocked people').click()
  await expect(bob.getByRole('list', { name: 'Blocked people' })).toContainText('Alice')
  await expect(messages(bob)).toHaveText([/Buy cheap watches/])

  // After unblocking, new messages arrive again.
  await bob.getByRole('button', { name: 'Unblock Alice' }).click()
  await expect(bob.getByLabel('Message')).toBeVisible()
  await alice.getByLabel('Message').fill('Sorry about that')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(messages(bob)).toHaveText([/Buy cheap watches/, /Sorry about that/])
})

test('chats from strangers wait in message requests (FR-SAF-3)', async ({ browser }) => {
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const mallory = await signUp(browser, 'Mallory', randomUsername())
  const bob = await signUp(browser, 'Bob', bobUsername)
  for (const [page, text] of [
    [alice, 'Hi, it is Alice'],
    [mallory, 'You won a prize'],
  ] as const) {
    await page.getByLabel("Contact's username").fill(bobUsername)
    await page.getByRole('button', { name: 'Start chat' }).click()
    await page.getByLabel('Message', { exact: true }).fill(text)
    await page.getByRole('button', { name: 'Send' }).click()
  }

  const requests = bob.getByRole('navigation', { name: 'Requests' })
  await expect(requests.getByRole('button')).toHaveCount(2)
  await expect(bob.getByRole('navigation', { name: 'Conversations' }).getByRole('button')).toHaveCount(0)

  // A request can be read but not answered until accepted.
  await requests.getByRole('button', { name: /Alice/ }).click()
  await expect(messages(bob)).toHaveText([/Hi, it is Alice/])
  await expect(bob.getByLabel('Message', { exact: true })).toBeHidden()
  await bob.getByRole('button', { name: 'Accept' }).click()
  await expect(bob.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /Alice/ })).toBeVisible()
  await bob.getByLabel('Message', { exact: true }).fill('Hi Alice')
  await bob.getByRole('button', { name: 'Send' }).click()
  await expect(messages(alice).filter({ hasText: 'Hi Alice' })).toBeVisible()

  // Blocking a request makes it disappear.
  await requests.getByRole('button', { name: /Mallory/ }).click()
  await bob.getByRole('note').getByRole('button', { name: 'Block' }).click()
  await expect(requests).toHaveCount(0)
  await mallory.getByLabel('Message', { exact: true }).fill('Are you there?')
  await mallory.getByRole('button', { name: 'Send' }).click()
  await expect(messages(mallory).filter({ hasText: 'Are you there?' })).toContainText('Sent')
  await expect(bob.getByText('Are you there?')).toHaveCount(0)
})

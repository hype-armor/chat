import { expect, test, type Locator, type Page } from './fixtures'
import { linkDevice, messages, openChat, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

async function action(page: Page, row: Locator, name: string) {
  await row.focus()
  await row.press('Shift+F10')
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function deleteMessage(page: Page, row: Locator, scope: 'me' | 'everyone') {
  await action(page, row, `Delete for ${scope}`)
  const dialog = page.getByRole('dialog', { name: `Delete for ${scope}?`, exact: true })
  if (scope === 'me') await expect(dialog).toContainText('your own linked devices when they connect')
  await dialog.getByRole('button', { name: `Delete for ${scope}`, exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test('encrypted Everyone deletion redacts the peer original and existing quotes, not the reply body', async ({ browser }) => {
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bobUsername = randomUsername()
  const bob = await signUp(browser, 'Bob', bobUsername)
  const original = 'Everyone deletion original'
  const reply = 'Keep the surviving reply body'
  await startChat(alice, bobUsername)
  await send(alice, original)
  await openChat(bob, /Alice/)
  await expect(messages(bob).filter({ hasText: original })).toBeVisible()
  await action(bob, messages(bob).filter({ hasText: original }), 'Reply')
  await send(bob, reply)
  await expect(messages(alice).filter({ hasText: reply })).toContainText(original)

  await deleteMessage(alice, messages(alice).filter({ hasText: original }).first(), 'everyone')
  for (const page of [alice, bob]) {
    await expect(messages(page).filter({ hasText: original })).toHaveCount(0)
    await expect(messages(page).filter({ hasText: reply })).toBeVisible()
    await expect(messages(page).filter({ hasText: reply })).toContainText('Original message unavailable')
    await expect(messages(page).getByText('Message deleted', { exact: true })).toBeVisible()
  }

  await bob.reload()
  await expect(bob.getByRole('status')).toHaveText('Connected')
  await openChat(bob, /Alice/)
  await expect(messages(bob).filter({ hasText: original })).toHaveCount(0)
  await expect(messages(bob).filter({ hasText: reply })).toContainText('Original message unavailable')
})

test('encrypted Me deletion synchronizes from a linked device without changing the other account', async ({ browser }) => {
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bobUsername = randomUsername()
  const bob = await signUp(browser, 'Bob', bobUsername)
  await startChat(alice, bobUsername)
  await send(alice, 'Establish the conversation before linking')
  await openChat(bob, /Alice/)
  const laptop = await linkDevice(browser, alice)
  await expect(laptop.getByRole('button', { name: /Bob/ })).toBeVisible({ timeout: 15_000 })
  await openChat(laptop, /Bob/)
  // A post-link encrypted message proves that both peers have applied the new epoch.
  const barrier = 'Linked-device membership is ready'
  await send(alice, barrier)
  for (const page of [bob, laptop]) await expect(messages(page).filter({ hasText: barrier })).toBeVisible()

  const original = 'Incoming original removed from Alice devices only'
  const reply = 'Keep the linked-device reply body'
  await send(bob, original)
  for (const page of [alice, laptop]) await expect(messages(page).filter({ hasText: original })).toBeVisible()
  await action(laptop, messages(laptop).filter({ hasText: original }), 'Reply')
  await send(laptop, reply)
  for (const page of [alice, bob]) await expect(messages(page).filter({ hasText: reply })).toContainText(original)

  // The incoming author is Bob. Alice can hide it privately, not delete it for Bob.
  const row = messages(laptop).filter({ hasText: original }).first()
  await row.focus()
  await row.press('Shift+F10')
  await expect(laptop.getByRole('menuitem', { name: 'Delete for everyone', exact: true })).toHaveCount(0)
  await laptop.keyboard.press('Escape')
  await deleteMessage(laptop, row, 'me')
  for (const page of [alice, laptop]) {
    await expect(messages(page).filter({ hasText: original })).toHaveCount(0)
    await expect(messages(page).filter({ hasText: reply })).toContainText('Original message unavailable')
  }
  // Negative control: Bob retains both the original and the readable quote.
  await expect(messages(bob).filter({ hasText: original })).toHaveCount(2)
  await expect(messages(bob).filter({ hasText: reply })).toContainText(original)

  await alice.reload()
  await expect(alice.getByRole('status')).toHaveText('Connected')
  await openChat(alice, /Bob/)
  await expect(messages(alice).filter({ hasText: original })).toHaveCount(0)
  await expect(messages(alice).filter({ hasText: reply })).toContainText('Original message unavailable')
  await expect(messages(bob).filter({ hasText: original })).toHaveCount(2)
})

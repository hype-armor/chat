import { expect, test } from '@playwright/test'
import { conversationAction, messages, openChat, randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test("a removed member's late message reaches nobody", async ({ browser, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit cannot reload while offline under Playwright')
  const benUsername = randomUsername()
  const ann = await signUp(browser, 'Ann', randomUsername())
  const ben = await signUp(browser, 'Ben', benUsername)
  await ann.getByText('New group').click()
  await ann.getByLabel('Group name').fill('Club')
  await ann.getByLabel("Members' usernames").fill(benUsername)
  await ann.getByRole('button', { name: 'Create group' }).click()
  await openChat(ben, /Club/)

  // Ben is offline (the app opens from its cache) and writes; meanwhile
  // Ann removes him. (WebKit can't reload an offline page in Playwright.)
  await ben.context().setOffline(true)
  await ben.reload()
  await expect(ben.getByRole('status')).not.toHaveText('online')
  await ben.getByRole('button', { name: /Club/ }).click()
  await ben.getByLabel('Message', { exact: true }).fill('Am I still here?')
  await ben.getByRole('button', { name: 'Send' }).click()
  await expect(messages(ben).filter({ hasText: 'Am I still here?' })).toContainText('Sending')
  await conversationAction(ann, 'Group info')
  await ann.getByRole('button', { name: 'Remove Ben' }).click()
  await expect(ann.getByText('1 people')).toBeVisible()

  // Back online, Ben's queued message, encrypted before he learned of the
  // removal, is accepted by the server (it can't read commits) but Ann's
  // app drops it: Ben isn't a member any more.
  await ben.context().setOffline(false)
  await expect(ben.getByText('You were removed from this group.')).toBeVisible({ timeout: 30_000 })
  await ann.getByLabel('Message', { exact: true }).fill('Still just me')
  await ann.getByRole('button', { name: 'Send' }).click()
  await expect(messages(ann)).toHaveText([/Still just me/])
})

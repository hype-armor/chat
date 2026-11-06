import { expect, test } from '@playwright/test'
import { conversationAction, createGroup, memberAction, messages, openChat, randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test("a removed member's late message reaches nobody", async ({ browser, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit cannot reload while offline under Playwright')
  const benUsername = randomUsername()
  const ann = await signUp(browser, 'Ann', randomUsername())
  const ben = await signUp(browser, 'Ben', benUsername)
  await createGroup(ann, 'Club', [benUsername])
  await openChat(ben, /Club/)

  await ben.context().grantPermissions(['geolocation'])
  await ben.context().setGeolocation({ latitude: 48.8584, longitude: 2.2945, accuracy: 12 })
  await ben.getByRole('button', { name: 'Add attachment' }).click()
  await ben.getByRole('menuitem', { name: 'Location', exact: true }).click()
  await ben.getByRole('dialog', { name: 'Share this location?' }).getByRole('button', { name: '15 min' }).click()
  const liveLocation = messages(ann).getByTestId('live-location')
  await expect(liveLocation).toContainText('48.85840, 2.29450')

  // Ben is offline (the app opens from its cache) and writes; meanwhile
  // Ann removes him. (WebKit can't reload an offline page in Playwright.)
  await ben.context().setOffline(true)
  await ben.reload()
  await expect(ben.getByRole('status', { name: 'Connection status' })).toHaveText(/Offline|Connecting…/)
  await ben.getByRole('button', { name: /Club/ }).click()
  await ben.getByLabel('Message', { exact: true }).fill('Am I still here?')
  await ben.getByRole('button', { name: 'Send' }).click()
  await expect(messages(ben).filter({ hasText: 'Am I still here?' }).getByRole('img', { name: 'Sending…', exact: true })).toBeVisible()
  await conversationAction(ann, 'Group info')
  await memberAction(ann, 'Ben', 'Remove')
  await expect(ann.locator('.conversation-title')).toContainText('1 people')
  await expect(liveLocation).toHaveText('📍 Live location ended')

  // Back online, Ben's queued message, encrypted before he learned of the
  // removal, is accepted by the server (it can't read commits) but Ann's
  // app drops it: Ben isn't a member any more.
  await ben.context().setOffline(false)
  await expect(ben.getByText('You were removed from this group.')).toBeVisible({ timeout: 30_000 })
  await ann.getByLabel('Message', { exact: true }).fill('Still just me')
  await ann.getByRole('button', { name: 'Send' }).click()
  // Ben's share stays as an ended card; his late message must not appear.
  await expect(messages(ann).filter({ hasText: 'Still just me' })).toHaveCount(1)
  await expect(messages(ann).filter({ hasText: 'Am I still here?' })).toHaveCount(0)
  await expect(liveLocation).toHaveText('📍 Live location ended')
})

import { type Browser, type Page, expect, test } from '@playwright/test'
import { openChat, randomUsername } from './support'

test.skip(!process.env.E2E_SERVER || !process.env.E2E_LIVEKIT, 'needs chat-server and LiveKit (E2E_LIVEKIT)')
test.skip(({ browserName }) => browserName === 'webkit', 'fake camera and microphone not set up for WebKit yet')

async function signUp(browser: Browser, browserName: string, name: string, username: string): Promise<Page> {
  const permissions = browserName === 'chromium' ? ['camera', 'microphone'] : []
  const page = await (await browser.newContext({ permissions })).newPage()
  await page.goto('/')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Sign up' }).click()
  await expect(page.getByRole('status')).toHaveText('online')
  return page
}

const width = (page: Page, label: string) =>
  page.getByLabel(label).evaluate((v) => (v as { videoWidth: number }).videoWidth)

test('a group video call through LiveKit, SFrame-encrypted (FR-CALL-2/3/6)', async ({ browser, browserName }) => {
  test.setTimeout(120_000)
  const [benName, catName] = [randomUsername(), randomUsername()]
  const ann = await signUp(browser, browserName, 'Ann', randomUsername())
  const ben = await signUp(browser, browserName, 'Ben', benName)
  const cat = await signUp(browser, browserName, 'Cat', catName)
  await ann.getByText('New group').click()
  await ann.getByLabel('Group name').fill('Standup')
  await ann.getByLabel("Members' usernames").fill(`${benName}\n${catName}`)
  await ann.getByRole('button', { name: 'Create group' }).click()
  await ann.getByLabel('Message', { exact: true }).fill('call?')
  await ann.getByRole('button', { name: 'Send', exact: true }).click()
  for (const page of [ben, cat]) await openChat(page, /Standup/)

  await ann.getByRole('button', { name: 'Group video call' }).click()
  const annCall = ann.getByRole('dialog', { name: 'Group call in Standup' })
  await expect(annCall).toContainText('in the call', { timeout: 30_000 })

  // Ben joins from the prompt; Cat from the conversation's banner.
  await ben.getByRole('dialog', { name: 'Group video call in Standup' }).getByRole('button', { name: 'Join' }).click()
  const banner = cat.getByRole('note').filter({ hasText: 'Call in progress' })
  await cat.getByRole('dialog', { name: 'Group video call in Standup' }).getByRole('button', { name: 'Not now' }).click()
  await banner.getByRole('button', { name: 'Join' }).click()

  for (const page of [ann, ben, cat]) {
    await expect(page.getByRole('status').filter({ hasText: 'in the call' })).toHaveText('3 in the call', { timeout: 30_000 })
    await expect(page.getByTestId('call-tile')).toHaveCount(3)
  }
  // Video from the others decrypts and plays: SFrame through the SFU.
  for (const [page, others] of [
    [ann, ['Ben', 'Cat']],
    [ben, ['Ann', 'Cat']],
    [cat, ['Ann', 'Ben']],
  ] as const) {
    for (const name of others) {
      await expect.poll(() => width(page, `${name}'s video`), { timeout: 30_000 }).toBeGreaterThan(0)
    }
  }

  await ann.getByRole('button', { name: 'Leave' }).click()
  for (const page of [ben, cat]) {
    await expect(page.getByRole('status').filter({ hasText: 'in the call' })).toHaveText('2 in the call', { timeout: 30_000 })
  }
  await expect(ann.getByTestId('notice').filter({ hasText: '🎥 You started a group video call' })).toBeVisible()
  await expect(ben.getByTestId('notice').filter({ hasText: '🎥 Ann started a group video call' })).toBeVisible()
})

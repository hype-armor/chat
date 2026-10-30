// Phase 0 spike (d) as a test: SFrame calls across browser engines, whose
// encoded-transform APIs differ (Chromium's encoded streams, Firefox's
// RTCRtpScriptTransform). WebKit joins once it has fake media on Linux.
import { type Browser, type Page, expect, firefox, test } from '@playwright/test'
import { openChat, randomUsername } from './support'

test.skip(!process.env.E2E_SERVER || !process.env.PW_ALL_BROWSERS, 'needs chat-server and Firefox (PW_ALL_BROWSERS)')
test.skip(({ browserName }) => browserName !== 'chromium', 'runs once, from the Chromium project')

const FIREFOX_PREFS = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
  'media.peerconnection.ice.obfuscate_host_addresses': false,
  'media.peerconnection.ice.loopback': true,
}

async function signUp(browser: Browser, name: string, username: string, baseURL: string, chromium: boolean): Promise<Page> {
  const context = await browser.newContext({ baseURL, permissions: chromium ? ['camera', 'microphone'] : [] })
  const page = await context.newPage()
  await page.goto('/')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Sign up' }).click()
  await expect(page.getByRole('status')).toHaveText('online')
  return page
}

const videoWidth = (page: Page, label: string) =>
  page.getByLabel(label).evaluate((v) => (v as { videoWidth: number }).videoWidth)

test('a 1:1 video call between Chromium and Firefox, SFrame both ways', async ({ browser, baseURL }) => {
  const fx = await firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS })
  try {
    const bobName = randomUsername()
    const alice = await signUp(browser, 'Alice', randomUsername(), baseURL!, true)
    const bob = await signUp(fx, 'Bob', bobName, baseURL!, false)
    await alice.getByLabel("Contact's username").fill(bobName)
    await alice.getByRole('button', { name: 'Start chat' }).click()
    await alice.getByLabel('Message', { exact: true }).fill('hi')
    await alice.getByRole('button', { name: 'Send', exact: true }).click()
    await openChat(bob, /Alice/)

    await alice.getByRole('button', { name: 'Video call', exact: true }).click()
    await bob.getByRole('dialog', { name: 'Incoming video call from Alice' }).getByRole('button', { name: 'Answer', exact: true }).click()
    await expect.poll(() => videoWidth(alice, "Bob's video"), { timeout: 20_000 }).toBeGreaterThan(0)
    await expect.poll(() => videoWidth(bob, "Alice's video"), { timeout: 20_000 }).toBeGreaterThan(0)
    await alice.getByRole('button', { name: 'Hang up' }).click()
  } finally {
    await fx.close()
  }
})

test('a three-party group call across Chromium and Firefox through LiveKit', async ({ browser, baseURL }) => {
  test.skip(!process.env.E2E_LIVEKIT, 'needs LiveKit (E2E_LIVEKIT)')
  test.setTimeout(120_000)
  const fx = await firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS })
  try {
    const [benName, catName] = [randomUsername(), randomUsername()]
    const ann = await signUp(browser, 'Ann', randomUsername(), baseURL!, true)
    const ben = await signUp(browser, 'Ben', benName, baseURL!, true)
    const cat = await signUp(fx, 'Cat', catName, baseURL!, false)
    await ann.getByText('New group').click()
    await ann.getByLabel('Group name').fill('Mixed')
    await ann.getByLabel("Members' usernames").fill(`${benName}\n${catName}`)
    await ann.getByRole('button', { name: 'Create group' }).click()
    await ann.getByLabel('Message', { exact: true }).fill('call?')
    await ann.getByRole('button', { name: 'Send', exact: true }).click()
    for (const page of [ben, cat]) await openChat(page, /Mixed/)

    await ann.getByRole('button', { name: 'Group video call' }).click()
    for (const page of [ben, cat]) {
      await page.getByRole('dialog', { name: 'Group video call in Mixed' }).getByRole('button', { name: 'Join' }).click()
    }
    for (const [page, others] of [
      [ann, ['Ben', 'Cat']],
      [ben, ['Ann', 'Cat']],
      [cat, ['Ann', 'Ben']],
    ] as const) {
      for (const name of others) {
        await expect.poll(() => videoWidth(page, `${name}'s video`), { timeout: 30_000 }).toBeGreaterThan(0)
      }
    }
  } finally {
    await fx.close()
  }
})

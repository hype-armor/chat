import { type Browser, type Page, expect, test } from '@playwright/test'
import { closeSettings, openChat, openSettings, randomUsername } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

/** Signs up in a context allowed to use the (fake) camera and microphone. */
async function signUp(browser: Browser, browserName: string, name: string, username: string): Promise<Page> {
  // Firefox takes no camera/microphone permissions here; its prefs allow them.
  const permissions = browserName === 'chromium' ? ['camera', 'microphone'] : []
  const page = await (await browser.newContext({ permissions })).newPage()
  await page.goto('/')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Your name').fill(name)
  await page.getByRole('button', { name: 'Sign up' }).click()
  await expect(page.getByRole('status')).toHaveText('online')
  return page
}

/** Alice and Bob in an accepted 1:1 chat, each with it open. */
async function pair(browser: Browser, browserName: string) {
  const bobUsername = randomUsername()
  const alice = await signUp(browser, browserName, 'Alice', randomUsername())
  const bob = await signUp(browser, browserName, 'Bob', bobUsername)
  await alice.getByLabel("Contact's username").fill(bobUsername)
  await alice.getByRole('button', { name: 'Start chat' }).click()
  await alice.getByLabel('Message', { exact: true }).fill('hi')
  await alice.getByRole('button', { name: 'Send', exact: true }).click()
  await openChat(bob, /Alice/)
  return { alice, bob }
}

test.describe('calls', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'fake camera and microphone not set up for WebKit yet')

  test('a 1:1 video call connects peer to peer and is logged (FR-CALL-1/4/5)', async ({ browser, browserName }) => {
    const { alice, bob } = await pair(browser, browserName)

    await alice.getByRole('button', { name: 'Video call', exact: true }).click()
    await expect(alice.getByRole('dialog', { name: 'Call with Bob' })).toContainText('Calling…')
    const ringing = bob.getByRole('dialog', { name: 'Incoming video call from Alice' })
    await ringing.getByRole('button', { name: 'Answer', exact: true }).click()

    // Connected: both show the running time, and media flows both ways.
    for (const page of [alice, bob]) {
      await expect(page.locator('.call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 20_000 })
    }
    for (const [page, other] of [
      [alice, 'Bob'],
      [bob, 'Alice'],
    ] as const) {
      const video = page.getByLabel(`${other}'s video`)
      await expect.poll(() => video.evaluate((v) => (v as { videoWidth: number }).videoWidth), { timeout: 15_000 }).toBeGreaterThan(0)
    }

    const mute = alice.getByRole('button', { name: 'Mute' })
    await mute.click()
    await expect(alice.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true')

    await alice.getByRole('button', { name: 'Hang up' }).click()
    await expect(bob.getByRole('dialog', { name: 'Call with Alice' })).toContainText('Call ended')
    for (const page of [alice, bob]) {
      await expect(page.getByTestId('notice').filter({ hasText: /🎥 Video call · \d+:\d\d/ })).toBeVisible()
    }
  })

  test('declined and missed calls leave notices', async ({ browser, browserName }) => {
    const { alice, bob } = await pair(browser, browserName)

    await alice.getByRole('button', { name: 'Voice call', exact: true }).click()
    await bob.getByRole('dialog', { name: 'Incoming voice call from Alice' }).getByRole('button', { name: 'Decline' }).click()
    await expect(alice.getByRole('dialog', { name: 'Call with Bob' })).toContainText('Declined')
    await expect(alice.getByTestId('notice').filter({ hasText: '📞 Voice call declined' })).toBeVisible()
    await expect(bob.getByTestId('notice').filter({ hasText: '📞 Declined voice call' })).toBeVisible()
    // The closing screen goes by itself.
    for (const page of [alice, bob]) await expect(page.getByRole('dialog')).toBeHidden()

    // Alice gives up before Bob answers.
    await alice.getByRole('button', { name: 'Voice call', exact: true }).click()
    await expect(bob.getByRole('dialog', { name: 'Incoming voice call from Alice' })).toBeVisible()
    await alice.getByRole('button', { name: 'Hang up' }).click()
    await expect(bob.getByRole('dialog', { name: 'Call with Alice' })).toContainText('Missed call')
    await expect(bob.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /Alice/ })).toContainText('📞 Missed voice call')
    await expect(alice.getByTestId('notice').filter({ hasText: '📞 Cancelled voice call' })).toBeVisible()
  })

  test('"always relay calls" refuses to call without a relay (FR-CALL-9)', async ({ browser, browserName }) => {
    const { alice } = await pair(browser, browserName)
    await openSettings(alice)
    await alice.getByText('Privacy').click()
    await alice.getByLabel('Always relay calls').check()
    await closeSettings(alice)
    await alice.getByRole('button', { name: /Bob/ }).click()
    // The test server offers no TURN server: a direct call would reveal the IP address.
    await alice.getByRole('button', { name: 'Voice call', exact: true }).click()
    await expect(alice.getByRole('dialog', { name: 'Call with Bob' })).toContainText('This server has no call relay')
  })

  test('a browser that cannot encrypt call media refuses to call (ADR-0030)', async ({ browser, browserName }) => {
    const { alice } = await pair(browser, browserName)
    // As in a browser without WebRTC encoded transforms.
    await alice.evaluate(() => {
      const w = globalThis as unknown as Record<string, unknown> & { RTCRtpSender: { prototype: Record<string, unknown> } }
      delete w.RTCRtpScriptTransform
      delete w.RTCRtpSender.prototype.createEncodedStreams
    })
    await alice.getByRole('button', { name: 'Video call', exact: true }).click()
    await expect(alice.getByRole('dialog', { name: 'Call with Bob' })).toContainText("can't encrypt call media")
  })

  test('the echo bot answers a video call and sends it back, SFrame and all', async ({ browser, browserName }) => {
    const alice = await signUp(browser, browserName, 'Alice', randomUsername())
    await alice.getByLabel("Contact's username").fill('echo.00')
    await alice.getByRole('button', { name: 'Start chat' }).click()
    await expect(alice.getByRole('heading', { name: 'Echo (test bot)' })).toBeVisible({ timeout: 15_000 })

    await alice.getByRole('button', { name: 'Video call', exact: true }).click()
    await expect(alice.locator('.call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 20_000 })
    // Alice's own (fake) camera, decrypted by the bot, re-encrypted under its key and decrypted here.
    const video = alice.getByLabel("Echo (test bot)'s video")
    await expect
      .poll(() => video.evaluate((v) => (v as { videoWidth: number }).videoWidth), { timeout: 20_000 })
      .toBeGreaterThan(0)
    await alice.getByRole('button', { name: 'Hang up' }).click()
    await expect(alice.getByTestId('notice').filter({ hasText: /🎥 Video call · \d+:\d\d/ })).toBeVisible()
  })
})

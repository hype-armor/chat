import { type Browser, type Page, expect, test } from '@playwright/test'
import { closeSettings, openChat, openSetting, randomUsername, startChat } from './support'

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
  await expect(page.getByRole('status')).toHaveText('Connected')
  return page
}

/** Alice and Bob in an accepted 1:1 chat, each with it open. */
async function pair(browser: Browser, browserName: string) {
  const bobUsername = randomUsername()
  const alice = await signUp(browser, browserName, 'Alice', randomUsername())
  const bob = await signUp(browser, browserName, 'Bob', bobUsername)
  await startChat(alice, bobUsername)
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

    await alice.evaluate("location.hash = 'diagnostics'")
    await expect(alice.getByTestId('self-test')).toHaveText('passed')
    await expect(alice.getByRole('dialog', { name: 'Call with Bob' })).toBeVisible()
    // A network change on the caller's side: ICE restarts over the encrypted
    // signalling, and media keeps coming (FR-CALL-8).
    const playedTo = () => bob.getByLabel("Alice's video").evaluate((v) => (v as { currentTime: number }).currentTime)
    await alice.evaluate("dispatchEvent(new Event('online'))")
    await alice.waitForTimeout(3_000)
    const before = await playedTo()
    await expect.poll(playedTo, { timeout: 10_000 }).toBeGreaterThan(before + 2)
    await expect(alice.locator('.call-status')).toHaveText(/^\d+:\d\d$/)

    // Screen sharing (FR-CALL-7): the same encrypted sender carries the screen.
    if (browserName === 'chromium') {
      await alice.getByRole('button', { name: 'Share screen' }).click()
      await expect(alice.getByRole('button', { name: 'Stop sharing' })).toHaveAttribute('aria-pressed', 'true')
      const at = await playedTo()
      await expect.poll(playedTo, { timeout: 10_000 }).toBeGreaterThan(at + 2)
      await alice.getByRole('button', { name: 'Stop sharing' }).click()
      await expect(alice.getByRole('button', { name: 'Share screen' })).toHaveAttribute('aria-pressed', 'false')
    }

    const mute = alice.getByRole('button', { name: 'Mute' })
    await mute.click()
    await expect(alice.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true')

    await alice.getByRole('button', { name: 'Hang up' }).click()
    await expect(bob.getByRole('dialog', { name: 'Call with Alice' })).toContainText('Call ended')
    await expect(alice.getByRole('dialog', { name: 'Call with Bob' })).toBeHidden()
    await alice.getByRole('button', { name: '← Back', exact: true }).click()
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
    await openSetting(alice, 'Privacy')
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
})

for (const kind of ['Voice', 'Video'] as const) {
  test(`the echo bot's ${kind.toLowerCase()} call controls fit at every viewport`, async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit has no encoded media transforms for encrypted calls')
    test.setTimeout(90_000)
    const alice = await signUp(browser, browserName, 'Alice', randomUsername())
    try {
      await startChat(alice, 'echo.00')
      await expect(alice.getByRole('heading', { name: 'Echo (test bot)' })).toBeVisible({ timeout: 15_000 })
      await alice.evaluate(`(() => {
        const original = HTMLMediaElement.prototype.setSinkId
        if (original) {
          HTMLMediaElement.prototype.setSinkId = async function (id) {
            await original.call(this, id)
            this.dataset.selectedSink = id
          }
        }
      })()`)

      await alice.getByRole('button', { name: `${kind} call`, exact: true }).click()
      await expect(alice.locator('.call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 20_000 })
      if (kind === 'Video') {
        // Alice's camera, decrypted by the bot, re-encrypted and decrypted here.
        const video = alice.getByLabel("Echo (test bot)'s video")
        await expect.poll(() => video.evaluate((v) => (v as { videoWidth: number }).videoWidth), { timeout: 20_000 }).toBeGreaterThan(0)
      }

      const dialog = alice.getByRole('dialog', { name: 'Call with Echo (test bot)' })
      for (const width of [320, 390, 768, 1280]) {
        await alice.setViewportSize({ width, height: 720 })
        const controls = dialog.locator('.call-controls')
        const boxes = await controls.getByRole('button').evaluateAll((elements) => elements.map((el) => {
          const { x, y, width, height } = el.getBoundingClientRect()
          return { x, y, width, height }
        }))
        expect(boxes.length).toBeGreaterThanOrEqual(kind === 'Video' ? 3 : 2)
        for (const [index, box] of boxes.entries()) {
          expect(box.width).toBeGreaterThanOrEqual(48)
          expect(box.height).toBeGreaterThanOrEqual(48)
          expect(box.y).toBe(boxes[0].y)
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(width)
          expect(box.y + box.height).toBeLessThanOrEqual(720)
          if (index > 0) expect(box.x).toBeGreaterThanOrEqual(boxes[index - 1].x + boxes[index - 1].width)
        }
        const info = (await dialog.locator('.call-info').boundingBox())!
        const dock = (await controls.boundingBox())!
        expect(info.y + info.height).toBeLessThanOrEqual(dock.y)
        if (kind === 'Video') {
          const self = (await dialog.getByLabel('Your video').boundingBox())!
          expect(self.y + self.height).toBeLessThan(dock.y)
          expect(self.y).toBeGreaterThanOrEqual(info.y + info.height)
          expect(self.x).toBeGreaterThanOrEqual(0)
          expect(self.x + self.width).toBeLessThanOrEqual(width)
          await expect(dialog.locator('.over-video')).toHaveCSS('color', 'rgb(255, 255, 255)')
          await expect(dialog.locator('.over-video .muted')).toHaveCSS('color', 'rgb(255, 255, 255)')
          await expect(dialog.locator('.over-video')).toHaveCSS('background-image', /linear-gradient/)
        }
      }

      await alice.setViewportSize({ width: 320, height: 720 })
      await dialog.getByRole('button', { name: 'Mute', exact: true }).click()
      await expect(dialog.getByRole('button', { name: 'Unmute', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await dialog.getByRole('button', { name: 'Unmute', exact: true }).click()
      await expect(dialog.getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute('aria-pressed', 'false')
      if (kind === 'Video') {
        await dialog.getByRole('button', { name: 'Camera off', exact: true }).click()
        await expect(dialog.getByRole('button', { name: 'Camera on', exact: true })).toHaveAttribute('aria-pressed', 'true')
        await expect(dialog.getByLabel('Your video')).toBeHidden()
        await dialog.getByRole('button', { name: 'Camera on', exact: true }).click()
        await expect(dialog.getByLabel('Your video')).toBeVisible()
      }
      const sharingSupported = await alice.evaluate<boolean>("'getDisplayMedia' in navigator.mediaDevices")
      await expect(dialog.getByRole('button', { name: 'Share screen', exact: true })).toHaveCount(kind === 'Video' && sharingSupported ? 1 : 0)
      const more = dialog.getByRole('button', { name: 'More call options' })
      if (await more.isVisible()) {
        await more.click()
        const menu = dialog.getByRole('menu', { name: 'More call options' })
        const menuBox = (await menu.boundingBox())!
        expect(menuBox.y).toBeGreaterThanOrEqual(0)
        expect(menuBox.x).toBeGreaterThanOrEqual(0)
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(320)
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual((await more.boundingBox())!.y)
        const output = menu.getByRole('menuitem', { name: 'Audio output: Default speaker', exact: true })
        if (await output.isVisible()) {
          expect((await output.boundingBox())!.height).toBeGreaterThanOrEqual(48)
          await output.click()
          await expect(dialog.locator('video').first()).toHaveAttribute('data-selected-sink', '')
        } else {
          await alice.keyboard.press('Escape')
        }
        await expect(menu).toBeHidden()
        await expect(more).toBeFocused()
      }
      await alice.getByRole('button', { name: 'Hang up' }).click()
      await expect(dialog).toBeHidden()
      await expect(alice.getByTestId('notice').filter({ hasText: new RegExp(`${kind} call · \\d+:\\d\\d`) })).toBeVisible()
    } finally {
      const hangUp = alice.getByRole('button', { name: 'Hang up' })
      if (await hangUp.isVisible()) await hangUp.click()
      await alice.context().close()
    }
  })
}

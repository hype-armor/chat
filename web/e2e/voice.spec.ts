import { expect, test } from '@playwright/test'
import { messages, openChat, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')
// Chromium's fake microphone and camera; other engines have no equivalent flags.
test.skip(({ browserName }) => browserName !== 'chromium', 'needs a fake microphone')
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } })

/** Whether the media element in `scope` has loaded and decoded its data. */
const decoded = (selector: string) =>
  `(() => { const el = document.querySelector('${selector}'); return !!el && el.readyState >= 2 && el.duration > 0 })()`

test('voice notes and video clips play on the other side (FR-MED-1)', async ({ browser }) => {
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobUsername)
  await startChat(alice, bobUsername)
  await alice.setViewportSize({ width: 360, height: 720 })

  // Complete a pending location lookup after the recorder takes over the row.
  await alice.evaluate(`navigator.geolocation.getCurrentPosition = (success) => {
    window.finishLocation = () => success({ coords: { latitude: 48.8584, longitude: 2.2945, accuracy: 12 } })
  }`)
  await alice.getByRole('button', { name: 'Add attachment' }).click()
  await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
  await expect(alice.getByRole('status').filter({ hasText: 'Finding location…' })).toBeVisible()
  await expect(alice.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0)
  await alice.getByRole('button', { name: 'Record a voice note' }).click()
  await expect(alice.getByLabel('Message', { exact: true })).toBeHidden()
  await expect(alice.getByRole('button', { name: 'Add attachment' })).toBeHidden()
  await expect(alice.getByRole('button', { name: 'Send voice note' })).toBeFocused()
  await alice.evaluate('window.finishLocation()')
  const preview = alice.getByRole('dialog', { name: 'Share this location?' })
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click()
  await alice.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(alice.getByLabel('Message', { exact: true })).toBeFocused()
  await expect(messages(alice)).toHaveCount(0)
  await alice.getByRole('button', { name: 'Record a voice note' }).click()
  await expect(alice.getByRole('status', { name: 'Recording a voice note' })).toContainText('0:01')
  await alice.getByRole('button', { name: 'Send voice note' }).click()
  const note = messages(alice).filter({ hasText: 'Voice note' })
  await expect(note.getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()
  await expect(alice.getByLabel('Message', { exact: true })).toBeFocused()
  await expect(alice.getByRole('button', { name: 'Record a voice note' })).toBeVisible()

  // A two-second clip made in the page (this file is type-checked without DOM types).
  const clip = Buffer.from(
    await alice.evaluate<number[]>(`(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 240
      const ctx = canvas.getContext('2d')
      const stream = canvas.captureStream(15)
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' })
      const chunks = []
      recorder.ondataavailable = (e) => chunks.push(e.data)
      const stopped = new Promise((r) => (recorder.onstop = r))
      recorder.start()
      const started = performance.now()
      while (performance.now() - started < 2000) {
        ctx.fillStyle = 'hsl(' + ((performance.now() / 10) % 360) + ', 70%, 50%)'
        ctx.fillRect(0, 0, 320, 240)
        await new Promise((r) => setTimeout(r, 50))
      }
      recorder.stop()
      await stopped
      return [...new Uint8Array(await new Blob(chunks).arrayBuffer())]
    })()`),
  )
  await alice.getByTestId('attach-input').setInputFiles({ name: 'clip.webm', mimeType: 'video/webm', buffer: clip })
  await expect(messages(alice).filter({ has: alice.getByRole('button', { name: 'Play clip.webm' }) })
    .getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()

  await expect(bob.getByRole('button', { name: /Alice/, includeHidden: true })).toContainText('Video')
  await openChat(bob, /Alice/)
  await bob.getByRole('button', { name: 'Play Voice note' }).click()
  await expect(bob.getByLabel('Voice note', { exact: true })).toBeVisible()
  await expect.poll(() => bob.evaluate<boolean>(decoded('audio'))).toBe(true)

  await bob.getByRole('button', { name: 'Play clip.webm' }).click()
  await expect(bob.getByLabel('clip.webm', { exact: true })).toBeVisible()
  await expect.poll(() => bob.evaluate<boolean>(decoded('video'))).toBe(true)
})

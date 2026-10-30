import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { messages, openChat, openSettings, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')
test('interrupted uploads and downloads resume where they stopped (ADR-0025)', async ({ browser, browserName }) => {
  // Cutting the worker's requests short needs request interception in workers.
  test.skip(browserName !== 'chromium', 'intercepts worker requests')
  test.setTimeout(90_000)
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobUsername)
  await startChat(alice, bobUsername)
  await alice.getByLabel('Message', { exact: true }).fill('Hello')
  await alice.getByRole('button', { name: 'Send', exact: true }).click()
  await openChat(bob, /Alice/)

  // 20 MB: three upload parts. The second part fails once.
  const data = randomBytes(20 * 1024 * 1024)
  const parts: string[] = []
  let failedPart = false
  await alice.context().route('**/v1/blobs/uploads/*/*', async (route) => {
    const part = route.request().url().split('/').pop()!
    if (route.request().method() !== 'PUT') return route.continue()
    if (part === '1' && !failedPart) {
      failedPart = true
      return route.abort('connectionreset')
    }
    parts.push(part)
    return route.continue()
  })
  await alice.getByTestId('attach-input').setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: data })
  const sent = messages(alice).filter({ hasText: 'big.bin' })
  await expect(sent).toContainText('Failed')
  await sent.getByRole('button', { name: 'Retry' }).click()
  await expect(sent.getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible({ timeout: 30_000 })
  // Part 0 went once: the retry asked the server what it had.
  expect(parts.sort()).toEqual(['0', '1', '2'])

  // Bob downloads in ranges; the third range fails once, then it resumes.
  const ranges: string[] = []
  let failedRange = false
  await bob.context().route('**/v1/blobs/*', async (route) => {
    const range = route.request().headers().range
    if (!range) return route.continue()
    if (ranges.length === 2 && !failedRange) {
      failedRange = true
      return route.abort('connectionreset')
    }
    ranges.push(range)
    return route.continue()
  })
  const received = messages(bob).filter({ hasText: 'big.bin' })
  await received.getByRole('button', { name: 'Download' }).click()
  await expect(received.getByRole('alert')).toBeVisible()
  const [file] = await Promise.all([bob.waitForEvent('download'), received.getByRole('button', { name: 'Download' }).click()])
  expect((await readFile((await file.path())!)).equals(data)).toBe(true)
  // Each 4 MB piece was fetched once: the retry started from the third.
  expect(new Set(ranges).size).toBe(ranges.length)
  expect(ranges[0]).toBe('bytes=0-4194303')
})

test('photos download by themselves unless turned off (FR-MED-6)', async ({ browser }) => {
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobUsername)
  await startChat(alice, bobUsername)
  await alice.getByLabel('Message', { exact: true }).fill('Hello')
  await alice.getByRole('button', { name: 'Send', exact: true }).click()
  await openChat(bob, /Alice/)

  const png = (color: string) =>
    alice.evaluate<number[]>(`(async () => {
      const c = new OffscreenCanvas(400, 300)
      const x = c.getContext('2d')
      x.fillStyle = '${color}'
      x.fillRect(0, 0, 400, 300)
      const b = await c.convertToBlob({ type: 'image/png' })
      return [...new Uint8Array(await b.arrayBuffer())]
    })()`)
  await alice.getByTestId('attach-input').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(await png('red')) })
  // Shown full size without a tap.
  await expect(messages(bob).locator('img[data-full="true"][alt="red.png"]')).toBeVisible()

  await openSettings(bob)

  await bob.getByText('Media').click()
  await bob.getByLabel('Photos', { exact: true }).selectOption('never')
  await alice.getByTestId('attach-input').setInputFiles({ name: 'blue.png', mimeType: 'image/png', buffer: Buffer.from(await png('blue')) })
  await expect(messages(bob).getByRole('button', { name: 'Show photo blue.png' })).toBeVisible()
  await bob.waitForTimeout(1000)
  await expect(messages(bob).locator('img[data-full="true"][alt="blue.png"]')).toHaveCount(0)
})

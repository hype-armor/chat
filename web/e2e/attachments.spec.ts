import { readFile } from 'node:fs/promises'
import { expect, test } from './fixtures'
import { closeDetails, conversationAction, conversationDetails, messages, openChat, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('animated GIF attachments preserve their caption and original bytes', async ({ browser }) => {
  const username = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', username)
  await startChat(alice, username)
  const gif = await readFile(new URL('./fixtures/animated.gif', import.meta.url))
  await alice.getByRole('textbox', { name: 'Message', exact: true }).fill('Animated greeting')
  await alice.getByTestId('attach-input').setInputFiles({ name: 'greeting.gif', mimeType: 'image/gif', buffer: gif })
  const sent = messages(alice).filter({ hasText: 'Animated greeting' })
  await expect(sent.getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()
  await expect(alice.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('')
  await openChat(bob, /Alice/)
  const received = messages(bob).filter({ hasText: 'Animated greeting' })
  await expect(received.getByRole('img', { name: 'greeting.gif' })).toHaveAttribute('data-full', 'true')
  const [download] = await Promise.all([
    bob.waitForEvent('download'), received.getByRole('button', { name: 'Save', exact: true }).click(),
  ])
  expect(download.suggestedFilename()).toBe('greeting.gif')
  expect(await readFile((await download.path())!)).toEqual(gif)
})

const MARKER = 'SECRET-GPS-48.8584N-2.2945E'

/** A JPEG made in the browser, with an EXIF block holding `MARKER` spliced in. */
function withExif(jpeg: Buffer): Buffer {
  const tiff = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    // Big-endian TIFF header, then IFD0 with no entries and no next IFD.
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from(MARKER, 'latin1'),
  ])
  const length = Buffer.alloc(2)
  length.writeUInt16BE(tiff.length + 2)
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, tiff, jpeg.subarray(2)])
}

test('attachments fit their bubbles at phone, tablet and desktop widths with details open', async ({ browser }) => {
  test.setTimeout(120_000)
  const username = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', username)
  try {
    await startChat(alice, username)
    for (const [name, width, height] of [
      ['landscape.png', 2400, 800],
      ['portrait.png', 800, 2400],
      ['tiny.png', 1, 1],
    ] as const) {
      const buffer = Buffer.from(await alice.evaluate<number[]>(`(async () => {
        const canvas = new OffscreenCanvas(${width}, ${height})
        const ctx = canvas.getContext('2d')
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        return [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())]
      })()`))
      await alice.getByTestId('attach-input').setInputFiles({ name, mimeType: 'image/png', buffer })
      await expect(messages(alice).filter({ has: alice.getByRole('img', { name }) })
        .getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()
    }
    const name = 'quarterly-financial-report-with-detailed-projections-and-supporting-notes-for-the-coming-year.pdf'
    await alice.getByTestId('attach-input').setInputFiles({
      name, mimeType: 'application/pdf', buffer: Buffer.from('file contents'),
    })
    await expect(messages(alice).filter({ hasText: name })
      .getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()
    await alice.evaluate(`navigator.geolocation.getCurrentPosition = (success) =>
      success({ coords: { latitude: 48.8584, longitude: 2.2945, accuracy: 12 } })`)
    await alice.getByRole('button', { name: 'Add attachment' }).click()
    await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
    await alice.getByRole('dialog', { name: 'Share this location?' }).getByRole('button', { name: 'Send location' }).click()
    await expect(messages(alice)).toHaveCount(5)
    await openChat(bob, /Alice/)
    await expect(messages(bob)).toHaveCount(5)

    for (const page of [alice, bob]) {
      await expect(page.locator('.attachment img[data-full="true"]')).toHaveCount(3)
      await page.getByRole('button', { name: 'Show map', exact: true }).click()
      await expect(page.locator('.location .map')).toBeVisible()
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 720 })
        for (const details of [false, true]) {
          if (details) {
            await conversationAction(page, 'Add people')
            await expect(conversationDetails(page)).toBeVisible()
          }
          // On phones details cover the conversation, but its hidden layout must still fit.
          const viewport = page.locator('.messages-viewport')
          await expect.poll(() => viewport.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
          const overflow = await messages(page).evaluateAll((bubbles) => bubbles.flatMap((bubble) => {
            const bounds = bubble.getBoundingClientRect()
            return [...bubble.querySelectorAll('.attachment, .attachment img, .photo, video, audio, .file-name, .file-download, .location, .map')]
              .filter((child) => {
                const rect = child.getBoundingClientRect()
                return rect.left < bounds.left - 1 || rect.right > bounds.right + 1
              }).map((child) => child.className || child.tagName)
          }))
          expect(overflow, `${width}px, details=${details}`).toEqual([])
          for (const [photo, ratio] of [['landscape.png', 3], ['portrait.png', 1 / 3], ['tiny.png', 1]] as const) {
            const image = page.getByRole('img', { name: photo, includeHidden: true })
            const size = await image.evaluate((el) => {
              const { width, height } = el.getBoundingClientRect()
              return { width, height }
            })
            expect(size.width).toBeGreaterThan(0)
            expect(size.height).toBeLessThanOrEqual(352)
            expect(size.width / size.height).toBeCloseTo(ratio, 1)
            if (photo === 'tiny.png') {
              expect(size.width).toBeLessThanOrEqual(64)
              expect(size.height).toBeLessThanOrEqual(64)
            }
          }
          const filename = page.locator('.file-card .file-name')
          await expect(filename).toHaveText(name)
          await expect(filename).toHaveAttribute('title', name)
          await expect(filename).toHaveCSS('-webkit-line-clamp', '2')
          if (width <= 390) {
            expect(await filename.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
            const fileLayout = await page.locator('.file-card').evaluate((card) => {
              const filename = card.querySelector('.file-name')!.getBoundingClientRect()
              const download = card.querySelector('.file-download')!.getBoundingClientRect()
              return download.top >= filename.bottom
            })
            expect(fileLayout).toBe(true)
          }
          await closeDetails(page)
        }
      }
    }
  } finally {
    await alice.context().close()
    await bob.context().close()
  }
})

test('photos lose their metadata, and files arrive intact', async ({ browser }) => {
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobUsername)
  await startChat(alice, bobUsername)

  // Runs in the page (a string: this file is type-checked without DOM types).
  const jpeg = Buffer.from(
    await alice.evaluate<number[]>(`(async () => {
      const canvas = new OffscreenCanvas(1200, 800)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#3a7'
      ctx.fillRect(0, 0, 1200, 800)
      ctx.fillStyle = '#fd2'
      ctx.fillRect(100, 100, 400, 300)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
      return [...new Uint8Array(await blob.arrayBuffer())]
    })()`),
  )
  const photo = withExif(jpeg)
  expect(photo.includes(MARKER)).toBe(true)

  await alice.getByRole('textbox', { name: 'Message', exact: true }).fill('The view')
  await alice.getByRole('button', { name: 'Add attachment' }).click()
  const chooser = alice.waitForEvent('filechooser')
  await alice.getByRole('menuitem', { name: 'Photo or file' }).click()
  await (await chooser).setFiles({ name: 'beach.jpg', mimeType: 'image/jpeg', buffer: photo })
  const sent = messages(alice).filter({ hasText: 'The view' })
  await expect(sent.or(alice.getByRole('alert'))).toBeVisible()
  expect(await alice.getByRole('alert').allTextContents()).toEqual([])
  await expect(sent.getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()
  await expect(sent.getByRole('img', { name: 'beach.jpg' })).toBeVisible()
  await expect(alice.getByLabel('Message', { exact: true })).toHaveValue('')
  await expect(alice.getByLabel('Message', { exact: true })).toBeFocused()

  await alice.getByTestId('attach-input').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello, encrypted file'),
  })
  await expect(messages(alice).filter({ hasText: 'notes.txt' }).getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()

  await alice.getByTestId('attach-input').setInputFiles({
    name: 'empty.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(0),
  })
  await expect(alice.getByRole('alert')).toHaveText('That file is empty')
  await expect(alice.getByRole('button', { name: 'Add attachment' })).toBeVisible()

  await expect(bob.getByRole('button', { name: /Alice/, includeHidden: true })).toContainText('File: notes.txt')
  await openChat(bob, /Alice/)
  const received = messages(bob).filter({ hasText: 'The view' })
  await expect(received.getByRole('img', { name: 'beach.jpg' })).toBeVisible()
  await expect(received.locator('.file-card')).toHaveCount(0)

  // The full photo: decrypted, without the EXIF block.
  // Photos download by themselves (ADR-0025) and show full size.
  await expect(received.locator('img[data-full="true"]')).toBeVisible()
  const [photoDownload] = await Promise.all([
    bob.waitForEvent('download'),
    received.getByRole('button', { name: 'Save' }).click(),
  ])
  expect(photoDownload.suggestedFilename()).toBe('beach.jpg')
  const saved = await readFile((await photoDownload.path())!)
  expect(saved.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  expect(saved.includes(MARKER)).toBe(false)
  expect(saved.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false)

  const file = messages(bob).filter({ hasText: 'notes.txt' })
  await expect(file.locator('.file-card')).toBeVisible()
  await expect(file.locator('.file-icon text')).toHaveText('TXT')
  await expect(file.locator('.file-card')).toContainText('21 B')
  const [fileDownload] = await Promise.all([
    bob.waitForEvent('download'),
    file.getByRole('button', { name: 'Download' }).click(),
  ])
  expect(fileDownload.suggestedFilename()).toBe('notes.txt')
  expect((await readFile((await fileDownload.path())!)).toString()).toBe('hello, encrypted file')

  // Opened again after a reload: from the copy kept on this device.
  await bob.reload()
  await openChat(bob, /Alice/)
  const again = messages(bob).filter({ hasText: 'notes.txt' })
  const [second] = await Promise.all([bob.waitForEvent('download'), again.getByRole('button', { name: 'Download' }).click()])
  expect((await readFile((await second.path())!)).toString()).toBe('hello, encrypted file')
})

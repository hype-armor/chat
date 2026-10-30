import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { messages, openChat, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

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

  await alice.getByLabel('Message').fill('The view')
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

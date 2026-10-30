import { expect, test } from '@playwright/test'
import { messages, randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('the echo bot sends back text and photos, end to end encrypted', async ({ browser }) => {
  const alice = await signUp(browser, 'Alice', randomUsername())
  await alice.getByLabel("Contact's username").fill('echo.00')
  await alice.getByRole('button', { name: 'Start chat' }).click()
  // Its profile names it once it has joined.
  await expect(alice.getByRole('heading', { name: 'Echo (test bot)' })).toBeVisible({ timeout: 15_000 })

  await alice.getByLabel('Message', { exact: true }).fill('ping 123')
  await alice.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(messages(alice).filter({ hasText: 'ping 123' })).toHaveCount(2)
  await expect(messages(alice).filter({ hasText: 'ping 123' }).first()).toContainText('Read')
  await expect(messages(alice).filter({ hasText: 'ping 123' }).last()).toHaveClass(/theirs/)

  // A photo comes back as the same encrypted attachment, and opens.
  const png = await alice.evaluate<number[]>(`(async () => {
    const c = new OffscreenCanvas(200, 100)
    const x = c.getContext('2d')
    x.fillStyle = 'teal'
    x.fillRect(0, 0, 200, 100)
    const b = await c.convertToBlob({ type: 'image/png' })
    return [...new Uint8Array(await b.arrayBuffer())]
  })()`)
  await alice.getByTestId('attach-input').setInputFiles({ name: 'teal.png', mimeType: 'image/png', buffer: Buffer.from(png) })
  const photos = messages(alice).filter({ has: alice.getByRole('img', { name: 'teal.png' }) })
  await expect(photos).toHaveCount(2)
  await expect(photos.last()).toHaveClass(/theirs/)
  await expect(photos.last().locator('img[data-full="true"]')).toBeVisible()
})

import { expect, test } from './fixtures'
import { conversationAction, messages, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('a 320px header can start a voice call from its menu with the echo bot', async ({ browser, browserName }) => {
  test.skip(browserName === 'webkit', 'fake microphone is not configured for WebKit')
  const alice = await signUp(browser, 'Alice', randomUsername())
  await alice.setViewportSize({ width: 320, height: 640 })
  await startChat(alice, 'echo.00')
  await expect(alice.getByRole('heading', { name: 'Echo (test bot)' })).toBeVisible({ timeout: 15_000 })
  // The echo bot is local to the isolated E2E services, never a live deployment.
  await conversationAction(alice, 'Voice call')
  const call = alice.getByRole('dialog', { name: 'Call with Echo (test bot)', exact: true })
  await expect(call).toBeVisible()
  await expect(call.locator('.call-status')).toHaveText(/^\d+:\d\d$/, { timeout: 30_000 })
  await call.getByRole('button', { name: 'Hang up', exact: true }).click()
  await expect(call).toBeHidden()
})

test('the echo bot sends back text and photos, end to end encrypted', async ({ browser }) => {
  const alice = await signUp(browser, 'Alice', randomUsername())
  await startChat(alice, 'echo.00')
  // Its profile names it once it has joined.
  await expect(alice.getByRole('heading', { name: 'Echo (test bot)' })).toBeVisible({ timeout: 15_000 })

  await alice.getByLabel('Message', { exact: true }).fill('ping 123')
  await alice.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(messages(alice).filter({ hasText: 'ping 123' })).toHaveCount(2)
  await expect(messages(alice).filter({ hasText: 'ping 123' }).first().getByRole('img', { name: 'Read', exact: true })).toBeVisible()
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

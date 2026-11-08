import { expect, test } from './fixtures'
import { messages, openSettings, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('server storage settings read authenticated quota and refresh after an encrypted file upload', async ({ browser }) => {
  test.setTimeout(120_000)
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobUsername)
  try {
    // Keep Settings and the conversation visible together. Narrow layout and
    // loading/error states have separate, controlled UI fixture coverage.
    await alice.setViewportSize({ width: 1280, height: 900 })
    await startChat(alice, bobUsername)
    await expect(alice.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
    await openSettings(alice)
    const panel = alice.getByRole('region', { name: 'Server storage', exact: true })
    const amount = (label: string) => panel.locator('.storage-totals > div')
      .filter({ has: alice.getByText(label, { exact: true }) }).locator('dd')
    const progress = panel.getByRole('progressbar', { name: 'Server storage including upload reservations' })
    const refresh = panel.getByRole('button', { name: 'Refresh server storage', exact: true })

    // This is the real core worker and authenticated server endpoint. Do not
    // mock fetch, inspect tokens, or call the server from the UI thread.
    await expect(panel.getByRole('status')).toHaveText('Latest server snapshot')
    await expect(amount('Used')).toHaveText('0 B')
    await expect(amount('Reserved for uploads')).toHaveText('0 B')
    await expect(amount('Account quota')).toHaveText('2 GiB')
    await expect(progress).toHaveAttribute('max', String(2 * 1024 ** 3))
    await expect(progress).toHaveAttribute('value', '0')
    await expect(panel.getByRole('alert')).toHaveCount(0)

    // The normal attachment flow encrypts and uploads through the core worker.
    const filename = 'storage-quota-check.txt'
    const payload = Buffer.from('A tiny encrypted attachment for the storage quota test.')
    await alice.getByTestId('attach-input').setInputFiles({
      name: filename,
      mimeType: 'text/plain',
      buffer: payload,
    })
    await expect(messages(alice).filter({ hasText: filename })
      .getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()

    await refresh.click()
    await expect(panel.getByRole('status')).toHaveText('Latest server snapshot')
    await expect(refresh).toBeEnabled()
    await expect.poll(async () => Number(await progress.getAttribute('value'))).toBeGreaterThan(payload.byteLength)
    const chargedBytes = Number(await progress.getAttribute('value'))
    expect(chargedBytes).toBeLessThan(1024 ** 2)
    await expect(amount('Used')).not.toHaveText('0 B')
    await expect(amount('Reserved for uploads')).toHaveText('0 B')
    await expect(amount('Account quota')).toHaveText('2 GiB')
    await expect(progress).toHaveAttribute('max', String(2 * 1024 ** 3))
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel.getByRole('note')).toHaveCount(0)

    // A second read must retain the committed charge after upload completion.
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(panel.getByRole('status')).toHaveText('Latest server snapshot')
    await expect(progress).toHaveAttribute('value', String(chargedBytes))
    await expect(amount('Reserved for uploads')).toHaveText('0 B')
  } finally {
    await alice.context().close()
    await bob.context().close()
  }
})

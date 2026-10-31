import { expect, test } from '@playwright/test'
import { closeDetails, conversationAction, conversationDetails, messages, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

for (const width of [390, 641, 768, 1280, 1920]) {
  test(`readable message column and file cards in light and dark mode (${width}px)`, async ({ browser }) => {
    const username = randomUsername()
    const alice = await signUp(browser, 'Alice', randomUsername())
    const bob = await signUp(browser, 'Bob', username)
    await alice.setViewportSize({ width, height: 720 })
    const empty = alice.getByRole('region', { name: 'Start a conversation', exact: true })
    if (width > 640) {
      for (const colorScheme of ['light', 'dark'] as const) {
        await alice.emulateMedia({ colorScheme })
        await expect(empty.getByRole('heading', { name: 'Your messages are end-to-end encrypted' })).toBeVisible()
        await empty.getByRole('button', { name: 'Start a chat', exact: true }).click()
        await expect(alice.getByLabel("Contact's username")).toBeFocused()
        await alice.getByRole('button', { name: '← Back', exact: true }).click()
        await empty.getByRole('button', { name: 'New group', exact: true }).click()
        await expect(alice.getByLabel('Group name', { exact: true })).toBeFocused()
        await alice.getByRole('button', { name: '← Back', exact: true }).click()
      }
    } else {
      await expect(empty).toBeHidden()
    }

    await startChat(alice, username)
    await alice.getByLabel('Message', { exact: true }).fill('A readable conversation. '.repeat(30))
    await alice.getByRole('button', { name: 'Send', exact: true }).click()
    const name = `${'a-long-file-name-'.repeat(6)}.pdf`
    await alice.getByTestId('attach-input').setInputFiles({
      name, mimeType: 'application/pdf', buffer: Buffer.from('file contents'),
    })
    const file = messages(alice).filter({ hasText: name })
    await expect(file.getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()

    for (const colorScheme of ['light', 'dark'] as const) {
      await alice.emulateMedia({ colorScheme })
      for (const details of width > 640 ? [false, true] : [false]) {
        if (details) {
          await conversationAction(alice, 'Add people')
          await expect(conversationDetails(alice)).toBeVisible()
        }
        const viewport = (await alice.locator('.messages-viewport').boundingBox())!
        const list = (await alice.locator('.messages').boundingBox())!
        const row = (await alice.locator('.composer-row').boundingBox())!
        const header = (await alice.locator('.conversation-bar').boundingBox())!
        expect(list.width).toBeLessThanOrEqual(56 * 16)
        expect(list.width).toBe(Math.min(viewport.width, 54 * 16))
        expect(Math.abs(list.x - viewport.x - (viewport.width - list.width) / 2)).toBeLessThan(1)
        expect(row.width).toBe(list.width)
        expect(row.x).toBe(list.x)
        expect(header.width).toBe(viewport.width)
        const card = file.locator('.file-card')
        await expect(card).toBeVisible()
        await expect(card.locator('.file-icon text')).toHaveText('PDF')
        await expect(card).toContainText('13 B')
        await expect(card.getByRole('button', { name: 'Download', exact: true })).toBeEnabled()
        expect(await card.locator('.file-name').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
        const bounds = (await card.boundingBox())!
        expect(bounds.x).toBeGreaterThanOrEqual(list.x)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(list.x + list.width)
        const download = (await card.getByRole('button', { name: 'Download', exact: true }).boundingBox())!
        expect(download.x + download.width).toBeLessThanOrEqual(bounds.x + bounds.width)
        expect(await alice.locator('.messages-viewport').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
        expect(await alice.evaluate('document.documentElement.scrollWidth')).toBe(width)
        expect(await alice.evaluate('document.documentElement.scrollHeight')).toBe(720)
        await closeDetails(alice)
      }
    }
    await alice.context().close()
    await bob.context().close()
  })
}

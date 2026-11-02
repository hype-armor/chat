import { expect, test } from '@playwright/test'
import { auditLayouts, expectLayout, layoutViewports } from './layout'
import {
  closeDetails, compose, conversationAction, conversationDetails, createGroup,
  messages, openChat, openSetting, randomUsername, signUp, startChat,
} from './support'

for (const { width, height, colorScheme } of layoutViewports) {
  test(`onboarding layout: ${width}×${height} ${colorScheme}`, async ({ page }) => {
    test.skip(!process.env.E2E_SERVER, 'link device needs chat-server (E2E_SERVER=1 and DATABASE_URL)')
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme })
    await page.goto('/')
    await expect(page.getByLabel('Username')).toBeVisible()
    await expectLayout(page, 'onboarding form')
    await page.getByRole('button', { name: /Link this one/ }).click()
    await expect(page.getByTestId('link-code')).toBeVisible()
    await expectLayout(page, 'link device')
    await page.getByRole('button', { name: 'Sign up with a new account instead', exact: true }).click()
    await page.getByRole('button', { name: /Restore from backup/ }).click()
    await expect(page.getByLabel('Recovery key')).toBeVisible()
    await expectLayout(page, 'restore')
  })
}

test.describe('signed-in layout lint', () => {
  test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (E2E_SERVER=1 and DATABASE_URL)')
  test.setTimeout(300_000)

  test('conversation, list, search, attachments and request layouts', async ({ browser }) => {
    const aliceUsername = randomUsername()
    const bobUsername = randomUsername()
    const alice = await signUp(browser, 'Alice', aliceUsername)
    const bob = await signUp(browser, 'Bob with a long display name', bobUsername)
    try {
      await auditLayouts(alice, 'empty list')
      await alice.getByRole('button', { name: 'New chat', exact: true }).click()
      await expect(alice.getByRole('menu', { name: 'New chat', exact: true })).toBeVisible()
      await auditLayouts(alice, 'compose menu')
      await alice.keyboard.press('Escape')
      for (const action of ['New chat', 'New group'] as const) {
        await compose(alice, action)
        await expect(alice.getByRole('region', { name: action, exact: true })).toBeVisible()
        await auditLayouts(alice, action)
        await alice.getByRole('button', { name: '← Back', exact: true }).click()
      }

      await startChat(alice, bobUsername)
      const composer = alice.getByLabel('Message', { exact: true })
      await expect(composer).toBeVisible()
      for (const text of [
        'A long message that wraps across multiple lines. '.repeat(12),
        `https://example.test/${'unbroken-path'.repeat(35)}`,
      ]) {
        await composer.fill(text)
        await alice.getByRole('button', { name: 'Send', exact: true }).click()
      }
      const filename = 'quarterly-financial-report-with-detailed-projections-and-supporting-notes-for-the-coming-year.pdf'
      await alice.getByTestId('attach-input').setInputFiles({
        name: filename, mimeType: 'application/pdf', buffer: Buffer.from('layout test document'),
      })
      await expect(messages(alice).filter({ hasText: filename })
        .getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()
      const png = await alice.evaluate<number[]>(`(async () => {
        const canvas = new OffscreenCanvas(800, 400)
        canvas.getContext('2d').fillRect(0, 0, 800, 400)
        return [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())]
      })()`)
      await alice.getByTestId('attach-input').setInputFiles({
        name: 'layout-photo.png', mimeType: 'image/png', buffer: Buffer.from(png),
      })
      await expect(alice.locator('.attachment img[data-full="true"]')).toBeVisible()
      await alice.context().grantPermissions(['geolocation'])
      await alice.context().setGeolocation({ latitude: 48.8584, longitude: 2.2945, accuracy: 12 })
      await alice.getByRole('button', { name: 'Add attachment' }).click()
      await expect(alice.getByRole('menu', { name: 'Add attachment', exact: true })).toBeVisible()
      await auditLayouts(alice, 'attach menu')
      await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
      const location = alice.getByRole('dialog', { name: 'Share this location?' })
      await expect(location).toContainText('48.85840, 2.29450')
      await auditLayouts(alice, 'location dialog')
      await location.getByRole('button', { name: 'Send location' }).click()
      await expect(messages(alice).getByTestId('location')).toBeVisible()
      await expect(messages(alice)).toHaveCount(5)
      await auditLayouts(alice, '1:1 conversation with long text, URL, PDF, photo and location')
      await composer.fill('A long draft with wrapping and many lines. '.repeat(60))
      await auditLayouts(alice, 'long draft')
      await alice.setViewportSize({ width: 390, height: 450 })
      await alice.emulateMedia({ colorScheme: 'dark' })
      await expect(composer).toBeInViewport()
      await expectLayout(alice, 'conversation at keyboard height with long draft', true)
      await composer.fill('')
      await alice.getByRole('button', { name: 'Conversation menu', exact: true }).click()
      await expect(alice.getByRole('menu', { name: 'Conversation menu' })).toBeVisible()
      await auditLayouts(alice, 'conversation menu')
      await alice.keyboard.press('Escape')
      for (const action of ['Verify safety number', 'Report']) {
        await conversationAction(alice, action)
        if (action === 'Report') await expect(conversationDetails(alice).getByRole('form')).toBeVisible()
        else await expect(alice.getByTestId('safety-number')).toBeVisible()
        await auditLayouts(alice, action)
        await closeDetails(alice)
      }

      // Bob keeps Alice's conversation as a request alongside six accepted groups.
      for (let i = 1; i <= 6; i++) await createGroup(bob, `Layout group ${i}`, [aliceUsername])
      await bob.setViewportSize({ width: 390, height: 844 })
      await bob.getByRole('button', { name: 'Back to conversations', exact: true }).click()
      const search = bob.getByRole('searchbox', { name: 'Search conversations' })
      await expect(search).toBeVisible()
      await bob.locator('.message-requests > summary').click()
      const request = bob.getByRole('navigation', { name: 'Requests', exact: true })
        .getByRole('button', { name: /Alice/ })
      await expect(request).toBeVisible()
      await expect(bob.getByRole('navigation', { name: 'Conversations', exact: true })
        .locator('.conversations button')).toHaveCount(6)
      await auditLayouts(bob, 'six chats, message request and search field')
      await search.fill('Layout')
      await expect(bob.locator('.conversations mark')).toHaveCount(6)
      await auditLayouts(bob, 'search results')
      await search.fill('')
      if (!(await request.isVisible())) await bob.locator('.message-requests > summary').click()
      await request.click()
      await expect(bob.getByRole('note')).toContainText('Accept')
      await expect(messages(bob)).toHaveCount(5)
      await auditLayouts(bob, 'message request view')
    } finally {
      await alice.context().close()
      await bob.context().close()
    }
  })

  test('group conversation, details, member menu, rename and add people layouts', async ({ browser }) => {
    const bobUsername = randomUsername()
    const bob = await signUp(browser, 'Bob with a long display name', bobUsername)
    const alice = await signUp(browser, 'Alice', randomUsername())
    try {
      await createGroup(alice, 'Weekend plans with a long group title', [bobUsername])
      await openChat(bob, /Weekend plans/)
      await bob.getByLabel('Message', { exact: true }).fill('A group message to audit. '.repeat(12))
      await bob.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(messages(alice).locator('.sender')).toHaveText('Bob with a long display name')
      await auditLayouts(alice, 'group conversation')
      await conversationAction(alice, 'Group info')
      const details = conversationDetails(alice)
      await expect(details.getByRole('list', { name: 'Members' })).toBeVisible()
      await auditLayouts(alice, 'group details')
      await details.getByRole('button', { name: 'Actions for Bob with a long display name', exact: true }).click()
      await expect(details.getByRole('menu')).toBeVisible()
      await auditLayouts(alice, 'member menu')
      await alice.keyboard.press('Escape')
      await details.getByRole('button', { name: 'Edit group name' }).click()
      await details.getByLabel('Group name', { exact: true }).fill('An edited group name with a long title')
      await auditLayouts(alice, 'edit group name')
      await details.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(details.getByLabel('Group name', { exact: true })).toBeHidden()
      await conversationAction(alice, 'Add people')
      await alice.getByLabel('Usernames to add').fill(`${randomUsername()}\n${randomUsername()}`)
      await auditLayouts(alice, 'add people')
    } finally {
      await alice.context().close()
      await bob.context().close()
    }
  })

  test('all Settings sections, created invite and Diagnostics layouts', async ({ browser }) => {
    const page = await signUp(browser, 'LongUnbrokenDisplayName'.repeat(2), randomUsername())
    try {
      const sections = [
        'Invite someone', 'Notifications', 'Privacy', 'Blocked people',
        'Linked devices', 'Backup', 'Media', 'This device', 'Delete account',
      ]
      for (const section of sections) await openSetting(page, section)
      const settings = page.getByRole('navigation', { name: 'Settings', exact: true })
      await expect(settings.locator('details[open]')).toHaveCount(sections.length)
      await auditLayouts(page, 'all Settings sections expanded')
      await settings.getByRole('button', { name: 'Create invite link', exact: true }).click()
      await expect(settings.getByTestId('invite-link')).toBeVisible()
      await auditLayouts(page, 'invite created')
      await settings.getByRole('button', { name: 'Link a new device', exact: true }).click()
      await settings.getByRole('button', { name: 'Turn on backup', exact: true }).click()
      await expect(settings.getByTestId('recovery-key')).toBeVisible()
      for (const { width, height, colorScheme } of layoutViewports) {
        await page.setViewportSize({ width, height })
        await page.emulateMedia({ colorScheme })
        for (const section of sections) {
          await settings.locator('summary').filter({ hasText: section }).scrollIntoViewIfNeeded()
          await expectLayout(page, `Settings scrolled to ${section}: ${width}×${height} ${colorScheme}`, true)
        }
      }
      await settings.getByRole('button', { name: 'Diagnostics', exact: true }).click()
      await expect(page.getByTestId('self-test')).toHaveText('passed')
      await auditLayouts(page, 'Diagnostics', false)
    } finally {
      await page.context().close()
    }
  })

  // Active echo calls use this same audit in calls.spec.ts, reusing its media
  // setup without adding competing calls to the single-call echo bot.
  test('WebKit voice and video call refusal layouts', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'active echo calls are audited in calls.spec.ts')
    const page = await signUp(browser, 'Alice', randomUsername())
    try {
      await startChat(page, 'echo.00')
      await expect(page.getByRole('heading', { name: 'Echo (test bot)' })).toBeVisible()
      for (const { width, height, colorScheme } of layoutViewports) {
        await page.setViewportSize({ width, height })
        await page.emulateMedia({ colorScheme })
        for (const kind of ['Voice', 'Video']) {
          await page.getByRole('button', { name: `${kind} call`, exact: true }).click()
          const dialog = page.getByRole('dialog', { name: 'Call with Echo (test bot)' })
          await expect(dialog).toContainText("can't encrypt call media")
          await expectLayout(page, `WebKit ${kind} call refusal: ${width}×${height} ${colorScheme}`, true)
          await expect(dialog).toBeHidden()
        }
      }
    } finally {
      await page.context().close()
    }
  })
})

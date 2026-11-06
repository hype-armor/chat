import { expect, test, type Page } from './fixtures'
import {
  closeDetails, closeSettings, compose, conversationAction, conversationDetails,
  createGroup, messages, openChat, openSetting, randomUsername, signUp, startChat,
} from './support'

/** Sample text and its background through each ancestor's alpha/opacity group. */
async function contrast(page: Page) {
  return page.locator('body').evaluate((body) => {
    const doc = body.ownerDocument
    const win = doc.defaultView!
    type Color = [number, number, number, number]
    const transparent: Color = [0, 0, 0, 0]
    const white: Color = [255, 255, 255, 1]
    const parse = (css: string): Color => {
      const parts = css.match(/[\d.]+/g)!.map(Number)
      return [parts[0], parts[1], parts[2], parts[3] ?? 1]
    }
    const over = (front: Color, back: Color): Color => {
      const alpha = front[3] + back[3] * (1 - front[3])
      if (!alpha) return [...transparent]
      return [
        ...[0, 1, 2].map((i) => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha),
        alpha,
      ] as Color
    }
    const luminance = (color: Color) => {
      const linear = color.slice(0, 3).map((v) => {
        const c = v / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    const results: { text: string; ratio: number; minimum: number }[] = []
    for (const element of [body, ...body.querySelectorAll('*')]) {
      if (element.closest('.visually-hidden, :disabled, [aria-disabled="true"], option, optgroup')) continue
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
      // Direct text nodes avoid auditing the same text again at every ancestor.
      // Nonempty control values are text too; placeholders deliberately are not.
      let text = [...element.childNodes]
        .filter((node) => node.nodeType === 3 && node.textContent?.trim())
        .map((node) => node.textContent!.trim()).join(' ')
        || (element.matches('textarea, input:not([type="checkbox"], [type="radio"], [type="file"], [type="range"], [type="color"], [type="image"])')
          ? (element as unknown as { value: string }).value : '')
      if (element.matches('select')) {
        text = (element as unknown as { selectedOptions: { textContent: string }[] }).selectedOptions[0]?.textContent ?? ''
      }
      if (!text) continue
      const style = win.getComputedStyle(element)
      let foreground = parse(style.color)
      let background: Color = [...transparent]
      for (let ancestor: typeof element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = win.getComputedStyle(ancestor)
        const fill = parse(ancestorStyle.backgroundColor)
        foreground = over(foreground, fill)
        background = over(background, fill)
        const opacity = Number(ancestorStyle.opacity)
        foreground[3] *= opacity
        background[3] *= opacity
      }
      const light = luminance(over(foreground, white))
      const dark = luminance(over(background, white))
      const size = parseFloat(style.fontSize)
      const large = size >= 18.66 || (size >= 14 && Number(style.fontWeight) >= 700)
      results.push({
        text: `${element.tagName.toLowerCase()}.${element.className}: ${text.slice(0, 100)}`,
        ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
        minimum: large ? 3 : 4.5,
      })
    }
    return results
  })
}

async function expectContrast(page: Page, screen: string) {
  const results = await contrast(page)
  expect(results.length, `${screen}: audit must not be empty`).toBeGreaterThan(0)
  expect(results.filter(({ ratio, minimum }) => ratio < minimum), screen).toEqual([])
}

test('contrast sampling blends transparent backgrounds and nested opacity', async ({ page }) => {
  await page.setContent(`
    <body style="background: white; color: black; font-size: 16px">
      <span>opaque</span>
      <div style="background: rgba(0,0,0,.5)"><span>alpha background</span></div>
      <div style="opacity: .5"><span style="opacity: .5">nested opacity</span></div>
      <button disabled style="color: white">disabled</button>
      <input placeholder="placeholder">
      <input type="checkbox">
      <input type="radio">
      <span hidden>hidden</span>
    </body>
  `)
  const results = await contrast(page)
  expect(results).toHaveLength(3)
  expect(results[0].ratio).toBeCloseTo(21, 2)
  expect(results[1].ratio).toBeCloseTo(5.28, 2)
  expect(results[2].ratio).toBeCloseTo(1.83, 2)
})

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [320, 390, 768, 1280]) {
    test(`onboarding contrast: ${colorScheme}, ${width}px`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible()
      await expectContrast(page, 'sign up')
      await page.getByRole('button', { name: /Restore from backup/ }).click()
      await expect(page.getByLabel('Recovery key')).toBeVisible()
      await expectContrast(page, 'restore')
      await page.getByRole('button', { name: 'Back', exact: true }).click()
      await page.getByRole('button', { name: 'Diagnostics', exact: true }).click()
      await expect(page.getByTestId('self-test')).toHaveText('passed')
      await expectContrast(page, 'diagnostics')
    })
  }

  test(`main screens contrast: ${colorScheme}`, async ({ browser, browserName }) => {
    test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL')
    test.setTimeout(180_000)
    const carolUsername = randomUsername()
    const carol = await signUp(browser, 'Carol', carolUsername)
    const alice = await signUp(browser, 'Alice', randomUsername())
    try {
      await alice.emulateMedia({ colorScheme })
      await carol.emulateMedia({ colorScheme })
      await alice.context().grantPermissions(['geolocation'])
      await alice.context().setGeolocation({ latitude: 48.8584, longitude: 2.2945, accuracy: 12 })
      // Audit all rendered text, including scrollable contents of expanded sections.
      const audit = async (screen: string, page = alice) => {
        for (const width of [320, 390, 768, 1280]) {
          await page.setViewportSize({ width, height: 900 })
          await expectContrast(page, `${screen}: ${colorScheme}, ${width}px`)
        }
      }
      await audit('empty list')
      for (const action of ['New chat', 'New group'] as const) {
        await compose(alice, action)
        await expect(alice.getByRole('region', { name: action, exact: true })).toBeVisible()
        if (action === 'New chat') {
          await alice.getByLabel("Contact's username").fill(carolUsername)
        } else {
          await alice.getByLabel('Group name', { exact: true }).fill('Contrast group')
          await alice.getByLabel("Members' usernames").fill(carolUsername)
        }
        await audit(action)
        await alice.getByRole('button', { name: '← Back', exact: true }).click()
      }
      await startChat(alice, carolUsername)
      await expect(alice.getByLabel('Message', { exact: true })).toBeVisible()
      await alice.getByLabel('Message', { exact: true }).fill('Hello Carol')
      await alice.getByRole('button', { name: 'Send', exact: true }).click()
      await alice.getByTestId('attach-input').setInputFiles({
        name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello, world!'),
      })
      await expect(messages(alice).filter({ hasText: 'notes.txt' }).locator('.muted')).toContainText('13 B')
      await alice.getByRole('button', { name: 'Add attachment' }).click()
      await alice.getByRole('menuitem', { name: 'Location', exact: true }).click()
      const location = alice.getByRole('dialog', { name: 'Share this location?' })
      await expect(location).toContainText('48.85840, 2.29450 · ±12 m')
      await audit('location dialog')
      await location.getByRole('button', { name: 'Send location' }).click()
      await expect(messages(alice).getByTestId('location')).toContainText('48.85840, 2.29450 · ±12 m')
      await alice.getByLabel('Message', { exact: true }).fill('Draft')
      await audit('own file and location')
      await alice.getByLabel('Message', { exact: true }).fill('')

      for (const action of ['Verify safety number', 'Report']) {
        await conversationAction(alice, action)
        await expect(conversationDetails(alice)).toBeVisible()
        if (action === 'Verify safety number') await expect(alice.getByTestId('safety-number')).toBeVisible()
        else await expect(conversationDetails(alice).getByRole('form')).toBeVisible()
        await audit(action)
        await closeDetails(alice)
      }
      // The existing call fixtures provide fake media on Chromium/Firefox only.
      await openChat(carol, /Alice/)
      if (browserName === 'chromium') await carol.context().grantPermissions(['microphone'])
      if (browserName !== 'webkit') {
        await carol.getByRole('button', { name: 'Voice call', exact: true }).click()
        const incoming = alice.getByRole('dialog', { name: 'Incoming voice call from Carol' })
        await expect(incoming).toBeVisible()
        await audit('incoming call')
        await audit('outgoing call and Hang up', carol)
        await incoming.getByRole('button', { name: 'Decline', exact: true }).click()
        await expect(incoming).toBeHidden()
      }

      await createGroup(alice, 'Contrast group', [carolUsername])
      await openChat(carol, /Contrast group/)
      await carol.getByLabel('Message', { exact: true }).fill('Hello from Carol')
      await carol.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(messages(alice).locator('.sender')).toHaveText('Carol')
      await audit('received group sender')
      await conversationAction(alice, 'Group info')
      await expect(conversationDetails(alice)).toBeVisible()
      await audit('group details')
      await closeDetails(alice)
      await conversationAction(alice, 'Add people')
      await alice.getByLabel('Usernames to add').fill(randomUsername())
      await audit('add people')
      await closeDetails(alice)

      // Search appears only at six conversations.
      for (let i = 1; i <= 4; i++) await createGroup(alice, `Search group ${i}`, [carolUsername])
      await alice.setViewportSize({ width: 390, height: 900 })
      await alice.getByRole('button', { name: 'Back to conversations', exact: true }).click()
      await alice.setViewportSize({ width: 1280, height: 900 })
      const search = alice.getByRole('searchbox', { name: 'Search conversations' })
      await search.fill('Contrast')
      await expect(alice.locator('.conversations mark')).toHaveText('Contrast')
      await audit('search highlight')
      await search.fill('')
      for (const section of [
        'Invite someone', 'Notifications', 'Privacy', 'Blocked people',
        'Linked devices', 'Backup', 'Media', 'This device', 'Delete account',
      ]) await openSetting(alice, section)
      await expect(alice.locator('.settings details[open]')).toHaveCount(9)
      await audit('all Settings sections')
      await alice.getByRole('button', { name: 'Create invite link', exact: true }).click()
      await expect(alice.getByTestId('invite-link')).toBeVisible()
      await alice.getByRole('button', { name: 'Link a new device', exact: true }).click()
      await alice.getByRole('button', { name: 'Turn on backup', exact: true }).click()
      await expect(alice.getByTestId('recovery-key')).toBeVisible()
      await audit('Settings invite, device linking and recovery key')
      await closeSettings(alice)
    } finally {
      await alice.context().close()
      await carol.context().close()
    }
  })
}

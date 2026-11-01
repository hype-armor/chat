import { expect, test, type Locator } from '@playwright/test'
import { conversationAction, conversationDetails, openSetting, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

async function expectNoOverflow(panel: Locator) {
  expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0)
  expect(await panel.evaluate((el) => {
    const bounds = el.getBoundingClientRect()
    return [...el.querySelectorAll('*')].filter((child) => {
      if (child.closest('.visually-hidden')) return false
      const rect = child.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && (rect.right > bounds.right + 1 || rect.left < bounds.left - 1)
    }).map((child) => `${child.tagName}.${child.className}: ${child.textContent}`)
  })).toEqual([])
}

async function expectChoicesFit(panel: Locator, count: number) {
  const choices = panel.locator('.choice')
  await expect(choices).toHaveCount(count)
  for (const choice of await choices.all()) {
    const input = choice.locator('input')
    await expect(input).toBeVisible()
    const control = (await input.boundingBox())!
    expect(control.width).toBeGreaterThan(0)
    expect(control.width).toBeLessThanOrEqual(24)
    const lines = await choice.evaluate((el) => {
      const range = el.ownerDocument.createRange()
      return [...el.childNodes].filter((node) => node.nodeType === 3 && node.textContent?.trim()).flatMap((node) => {
        range.selectNodeContents(node)
        return [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => ({
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        }))
      })
    })
    expect(lines.length).toBeGreaterThan(0)
    const label = (await choice.boundingBox())!
    for (const line of lines) {
      expect(line.left).toBeGreaterThanOrEqual(control.x + control.width)
      expect(line.right).toBeLessThanOrEqual(label.x + label.width + 1)
    }
    expect(control.y).toBeGreaterThanOrEqual(lines[0].top - 1)
    expect(control.y).toBeLessThan(lines[0].bottom)
  }
}

for (const width of [320, 390]) {
  test(`all Settings sections fit a narrow screen (${width}px)`, async ({ browser }) => {
    const page = await signUp(browser, 'LongUnbrokenDisplayName'.repeat(2), randomUsername())
    await page.setViewportSize({ width, height: 844 })
    const names = [
      'Invite someone', 'Notifications', 'Privacy', 'Blocked people',
      'Linked devices', 'Backup', 'Media', 'This device', 'Delete account',
    ]
    for (const name of names) await openSetting(page, name)
    const settings = page.getByRole('navigation', { name: 'Settings', exact: true })
    await expect(settings.locator('details[open]')).toHaveCount(names.length)
    await settings.getByRole('button', { name: 'Create invite link', exact: true }).click()
    await expect(settings.getByTestId('invite-link')).toBeVisible()
    await settings.getByRole('button', { name: 'Link a new device', exact: true }).click()
    await settings.getByRole('button', { name: 'Turn on backup', exact: true }).click()
    await expect(settings.getByTestId('recovery-key')).toBeVisible()
    await expectChoicesFit(settings, 4)
    await expectNoOverflow(settings)
    for (const name of ['Send read receipts', 'Always relay calls', 'Share anonymous call statistics']) {
      const checkbox = settings.getByLabel(name, { exact: true })
      const checked = await checkbox.isChecked()
      await checkbox.setChecked(!checked)
      await expect(checkbox).toBeChecked({ checked: !checked })
    }
    expect(await page.evaluate('document.documentElement.scrollWidth')).toBe(width)
    await page.context().close()
  })

  test(`Report checkboxes and radios fit a narrow screen (${width}px)`, async ({ browser }) => {
    const username = randomUsername()
    const alice = await signUp(browser, 'Alice', randomUsername())
    const bob = await signUp(browser, 'LongUnbrokenDisplayName'.repeat(2), username)
    await alice.setViewportSize({ width, height: 844 })
    await startChat(alice, username)
    await conversationAction(alice, 'Report')
    const report = conversationDetails(alice).getByRole('form')
    await expect(report).toBeVisible()
    await expectChoicesFit(report, 5)
    await expectNoOverflow(report)
    await expectNoOverflow(alice.locator('.details-content'))
    await report.getByLabel('Harassment or abuse').check()
    await expect(report.getByLabel('Harassment or abuse')).toBeChecked()
    await report.getByLabel(/Include their last 10 messages/).uncheck()
    await expect(report.getByLabel(/Include their last 10 messages/)).not.toBeChecked()
    expect(await alice.evaluate('document.documentElement.scrollWidth')).toBe(width)
    await alice.context().close()
    await bob.context().close()
  })
}

import { expect, test } from '@playwright/test'
import { closeSettings, openSetting, openSettings, randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('groups every setting and keeps account deletion last', async ({ browser }) => {
  const username = randomUsername()
  const page = await signUp(browser, 'Pat', username)
  await page.setViewportSize({ width: 390, height: 844 })
  await openSettings(page)
  const settings = page.getByRole('navigation', { name: 'Settings', exact: true })
  await expect(settings.getByRole('heading', { level: 3 })).toHaveText([
    'Account', 'Notifications & privacy', 'Devices & data', 'About', 'Danger zone',
  ])
  await expect(settings.getByRole('region').last()).toHaveAccessibleName('Danger zone')
  await expect(settings.locator('summary').last()).toHaveText('Delete account')
  await expect(settings.getByRole('region', { name: 'Account', exact: true })).toContainText('Pat')
  await expect(settings.getByText(`Your username: ${username}`, { exact: true })).toBeVisible()
  await page.evaluate(`navigator.clipboard.writeText = async () => { throw new Error('Clipboard permission denied') }`)
  await settings.getByRole('button', { name: 'Copy username' }).click()
  await expect(settings.getByRole('alert')).toHaveText('Clipboard permission denied')
  await page.evaluate(`navigator.clipboard.writeText = async (text) => { window.copiedUsername = text }`)
  await settings.getByRole('button', { name: 'Copy username' }).click()
  await expect(settings.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  await expect(settings.getByRole('alert')).toHaveCount(0)
  expect(await page.evaluate('window.copiedUsername')).toBe(username)

  const rows = [
    ['Account', ['Invite someone']],
    ['Notifications & privacy', ['Notifications', 'Privacy', 'Blocked people']],
    ['Devices & data', ['Linked devices', 'Backup', 'Media', 'This device']],
    ['Danger zone', ['Delete account']],
  ] as const
  for (const [group, names] of rows) {
    const region = settings.getByRole('region', { name: group, exact: true })
    for (const name of names) {
      const section = await openSetting(page, name)
      await expect(region.locator('summary').filter({ hasText: name })).toBeVisible()
      // Reopening through the helper must not collapse an already-open row.
      await openSetting(page, name)
      await expect(section).toHaveAttribute('open', '')
      await section.locator('summary').click()
      await expect(section).not.toHaveAttribute('open')
    }
  }

  const privacy = await openSetting(page, 'Privacy')
  await privacy.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(privacy).not.toHaveAttribute('open')
  await page.keyboard.press('Space')
  await expect(privacy).toHaveAttribute('open', '')
  await expect(privacy.getByLabel('Send read receipts')).toBeVisible()
  await settings.getByRole('button', { name: 'Diagnostics' }).click()
  await expect(page.getByText('Core version', { exact: true })).toBeVisible()
  await expect(page.getByTestId('self-test')).toHaveText('passed')
})

test('solid danger buttons have white text and AA contrast in both themes', async ({ browser }) => {
  const page = await signUp(browser, 'Pat', randomUsername())
  await openSetting(page, 'Delete account')
  const button = page.getByRole('button', { name: 'Delete my account', exact: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(button).toHaveCSS('color', 'rgb(255, 255, 255)')
    const contrast = await page.evaluate(`(() => {
      const luminance = (color) => {
        const rgb = color.match(/\\d+/g).slice(0, 3).map((value) => {
          const channel = Number(value) / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
      }
      const style = getComputedStyle(document.querySelector('.danger-zone button.danger'))
      const fg = luminance(style.color)
      const bg = luminance(style.backgroundColor)
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
    })()`)
    await expect(button).toHaveCSS('background-color', 'rgb(207, 34, 46)')
    expect(contrast).toBeGreaterThanOrEqual(4.5)
  }
})

for (const mode of ['unavailable', 'installed', 'ios'] as const) {
  test(`This device presents installation appropriately: ${mode}`, async ({ browser }) => {
    const context = await browser.newContext()
    await context.addInitScript({ content: `
      const matchMedia = window.matchMedia.bind(window)
      window.matchMedia = (query) => query === '(display-mode: standalone)'
        ? Object.defineProperty(matchMedia(query), 'matches', { value: ${mode === 'installed'} })
        : matchMedia(query)
      // This test covers a browser without an install prompt.
      window.addEventListener('beforeinstallprompt', (event) => event.stopImmediatePropagation(), true)
      Object.defineProperty(navigator.storage, 'persisted', { value: async () => true })
      if (${mode === 'ios'}) Object.defineProperty(navigator, 'userAgent', { value: 'iPhone Version/18.0 Safari/604.1' })
    ` })
    const page = await context.newPage()
    await page.goto('/')
    await page.getByLabel('Username').fill(randomUsername())
    await page.getByLabel('Your name').fill('Pat')
    await page.getByRole('button', { name: 'Sign up' }).click()
    await expect(page.getByRole('status')).toHaveText('Connected')
    const section = await openSetting(page, 'This device')
    await expect(section.getByRole('button', { name: 'Install app', exact: true })).toHaveCount(0)
    await expect(section.getByRole('button', { name: 'Keep data on this device' })).toBeDisabled()
    await expect(section).toContainText('Data is kept on this device.')
    if (mode === 'installed') await expect(section).toContainText('Chat is installed.')
    else if (mode === 'unavailable') await expect(section.getByRole('heading', { name: 'Install app' })).toHaveCount(0)
    else {
      await expect(section).toContainText('Share, then Add to Home Screen')
      await closeSettings(page)
      await page.setViewportSize({ width: 390, height: 844 })
      const install = page.getByRole('region', { name: 'Install', exact: true })
      await expect(install).toContainText('Share → Add to Home Screen')
      expect((await install.boundingBox())!.height).toBeLessThanOrEqual(54)
      await install.getByRole('button', { name: 'Dismiss setup reminder' }).click()
      await expect(install).toHaveCount(0)
    }
    await context.close()
  })
}

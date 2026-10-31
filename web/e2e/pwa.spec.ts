import { expect, test } from '@playwright/test'
import { closeSettings, openSetting, openSettings, randomUsername, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('asks to keep data on this device, and warns if refused (FR-PLAT-3)', async ({ browser, browserName }) => {
  // Firefox answers persist() with a permission prompt headless tests can't click.
  test.skip(browserName !== 'chromium', 'Chromium answers persist() without a prompt')
  const page = await signUp(browser, 'Pat', randomUsername())
  const storage = page.getByRole('region', { name: 'Storage' })
  await expect(storage).toContainText('Keep your keys safe')
  await storage.getByRole('button', { name: 'Keep', exact: true }).click()
  // Granted: the banner goes. Refused: it turns into a warning.
  await expect(storage.getByRole('button', { name: 'Keep', exact: true })).toHaveCount(0)
  if (await storage.isVisible()) {
    await expect(storage).toContainText('may delete')
    await storage.getByRole('button', { name: 'Dismiss setup reminder' }).click()
    await expect(storage).toBeHidden()
  }
})

test.describe('setup reminders and Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript({ content: `
      Object.defineProperty(navigator.storage, 'persisted', { value: async () => false });
      Object.defineProperty(navigator.storage, 'persist', { value: async () => false });
      window.addEventListener('load', () => {
        const event = new Event('beforeinstallprompt', { cancelable: true });
        event.prompt = async () => { localStorage.setItem('test.install-prompted', 'yes'); };
        window.dispatchEvent(event);
      });
    ` })
    await page.goto('/')
    await page.getByLabel('Username').fill(randomUsername())
    await page.getByLabel('Your name').fill('Pat')
    await page.getByRole('button', { name: 'Sign up' }).click()
    await expect(page.getByRole('status')).toHaveText('Connected')
  })

  test('shows only one setup reminder, and retains dismissed actions in Settings', async ({ page }) => {
    const storage = page.getByRole('region', { name: 'Storage', exact: true })
    const install = page.getByRole('region', { name: 'Install', exact: true })
    await expect(storage).toContainText('Keep your keys safe')
    await expect(install).toHaveCount(0)
    await storage.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect(storage).toContainText('may delete')
    await expect(install).toHaveCount(0)
    await storage.getByRole('button', { name: 'Dismiss setup reminder' }).click()
    await expect(storage).toHaveCount(0)
    await expect(install).toBeVisible()
    await install.getByRole('button', { name: 'Dismiss setup reminder' }).click()
    await expect(install).toHaveCount(0)

    await openSetting(page, 'This device')
    await page.getByRole('button', { name: 'Keep data on this device' }).click()
    await expect(page.getByText("Your browser may delete this app's data when storage runs low.", { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Install app', exact: true }).click()
    await expect.poll(() => page.evaluate("localStorage.getItem('test.install-prompted')")).toBe('yes')
    await closeSettings(page)
    await expect(storage).toHaveCount(0)
    await expect(install).toHaveCount(0)
  })

  test('remembers dismissals after reload and brings reminders back after 14 days', async ({ page }) => {
    await page.getByRole('region', { name: 'Storage' }).getByRole('button', { name: 'Dismiss setup reminder' }).click()
    await page.getByRole('region', { name: 'Install' }).getByRole('button', { name: 'Dismiss setup reminder' }).click()
    await page.reload()
    await expect(page.getByRole('status')).toHaveText('Connected')
    await expect(page.getByRole('region', { name: /^(Storage|Install)$/ })).toHaveCount(0)
    await page.evaluate(`
      const dismissed = JSON.parse(localStorage.getItem('chat.setup-dismissals'));
      for (const key of Object.keys(dismissed)) dismissed[key] = Date.now() - 15 * 24 * 60 * 60 * 1000;
      localStorage.setItem('chat.setup-dismissals', JSON.stringify(dismissed));
    `)
    await page.reload()
    await expect(page.getByRole('region', { name: 'Storage' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Install' })).toHaveCount(0)
  })

  test('keeps each setup reminder within two lines on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const storage = page.getByRole('region', { name: 'Storage', exact: true })
    const install = page.getByRole('region', { name: 'Install', exact: true })
    const expectCompact = async () => {
      const banner = page.locator('.setup-banner')
      await expect(banner).toBeVisible()
      const bounds = await banner.boundingBox()
      expect(bounds!.height).toBeLessThanOrEqual(54)
      const dismiss = banner.getByRole('button', { name: 'Dismiss setup reminder' })
      await expect(dismiss).toBeVisible()
      const dismissBounds = await dismiss.boundingBox()
      expect(dismissBounds!.x + dismissBounds!.width).toBeLessThanOrEqual(390)
      const conversations = await page.getByRole('navigation', { name: 'Conversations', exact: true }).boundingBox()
      expect(conversations!.y).toBeCloseTo(bounds!.y + bounds!.height)
    }
    await expectCompact()
    await storage.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect(storage).toContainText('may delete')
    await expectCompact()
    await storage.getByRole('button', { name: 'Dismiss setup reminder' }).click()
    await expect(install).toBeVisible()
    await expectCompact()
    await install.getByRole('button', { name: 'Install app', exact: true }).click()
    await expect.poll(() => page.evaluate("localStorage.getItem('test.install-prompted')")).toBe('yes')
    await expect(install).toHaveCount(0)
  })

  test('fills desktop and mobile viewports and opens diagnostics from Settings', async ({ page }) => {
    await expect(page.getByRole('contentinfo')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toHaveCount(0)
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      const bounds = await page.locator('.chat-layout').boundingBox()
      expect(bounds?.y).toBe(0)
      expect(bounds?.height).toBe(viewport.height)
      expect(bounds?.width).toBe(viewport.width)
    }
    await openSettings(page)
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click()
    await expect(page.getByTestId('self-test')).toHaveText('passed')
    await page.getByRole('button', { name: '← Back', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Settings', exact: true })).toBeVisible()
  })
})

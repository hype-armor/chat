import { expect, test } from '@playwright/test'
import { closeSettings, messages, openSettings, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('asks to keep data on this device, and warns if refused (FR-PLAT-3)', async ({ browser, browserName }) => {
  // Firefox answers persist() with a permission prompt headless tests can't click.
  test.skip(browserName !== 'chromium', 'Chromium answers persist() without a prompt')
  const page = await signUp(browser, 'Pat', randomUsername())
  const storage = page.getByRole('region', { name: 'Storage' })
  await expect(storage).toContainText('Keep your keys and messages safe')
  await storage.getByRole('button', { name: 'Keep data on this device' }).click()
  // Granted: the banner goes. Refused: it turns into a warning.
  await expect(storage.getByRole('button', { name: 'Keep data on this device' })).toHaveCount(0)
  if (await storage.isVisible()) {
    await expect(storage).toContainText('may delete')
    await storage.getByRole('button', { name: 'Not now' }).click()
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
    await expect(storage).toContainText('Keep your keys and messages safe')
    await expect(install).toHaveCount(0)
    await storage.getByRole('button', { name: 'Keep data on this device' }).click()
    await expect(storage).toContainText('may delete')
    await expect(install).toHaveCount(0)
    await storage.getByRole('button', { name: 'Not now' }).click()
    await expect(storage).toHaveCount(0)
    await expect(install).toBeVisible()
    await install.getByRole('button', { name: 'Not now' }).click()
    await expect(install).toHaveCount(0)

    await openSettings(page)
    await page.getByText('This device', { exact: true }).click()
    await page.getByRole('button', { name: 'Keep data on this device' }).click()
    await expect(page.getByText("Your browser may delete this app's data when storage runs low.", { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Install app', exact: true }).click()
    await expect.poll(() => page.evaluate("localStorage.getItem('test.install-prompted')")).toBe('yes')
    await closeSettings(page)
    await expect(storage).toHaveCount(0)
    await expect(install).toHaveCount(0)
  })

  test('remembers dismissals after reload and brings reminders back after 14 days', async ({ page }) => {
    await page.getByRole('region', { name: 'Storage' }).getByRole('button', { name: 'Not now' }).click()
    await page.getByRole('region', { name: 'Install' }).getByRole('button', { name: 'Not now' }).click()
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

  test('fills desktop and mobile viewports and opens diagnostics from Settings', async ({ page }) => {
    await expect(page.getByRole('contentinfo')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toHaveCount(0)
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 390, height: 500 }]) {
      await page.setViewportSize(viewport)
      await expect.poll(async () => {
        const bounds = await page.locator('.chat-layout').boundingBox()
        return bounds && { top: bounds.y, height: bounds.height, width: bounds.width }
      }).toEqual({ top: 0, height: viewport.height, width: viewport.width })
    }
    await openSettings(page)
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click()
    await expect(page.getByTestId('self-test')).toHaveText('passed')
    await page.getByRole('button', { name: '← Back', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Settings', exact: true })).toBeVisible()
  })

  test('keeps the conversation inside a panned iOS visual viewport', async ({ page, browser }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript({ content: `
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 }),
      })
    ` })
    await page.reload()
    await expect(page.getByRole('status')).toHaveText('Connected')
    const username = randomUsername()
    await signUp(browser, 'Bob', username)
    await startChat(page, username)
    const input = page.getByLabel('Message', { exact: true })
    for (let i = 0; i < 12; i++) {
      await input.fill(`Keyboard history ${i}`)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(messages(page).last()).toContainText(`Keyboard history ${i}`)
    }
    await input.focus()
    const layout = page.locator('.chat-layout')
    const expectBounds = async (top: number, height: number) => {
      await expect.poll(async () => {
        const bounds = await layout.boundingBox()
        return bounds && { top: bounds.y, height: bounds.height, width: bounds.width }
      }).toEqual({ top, height, width: 390 })
    }
    const changeViewport = async (height: number, offsetTop: number, event: 'resize' | 'scroll') => {
      await page.evaluate(`
        Object.assign(window.visualViewport, ${JSON.stringify({ height, offsetTop })});
        window.visualViewport.dispatchEvent(new Event(${JSON.stringify(event)}));
      `)
    }
    const expectConversationFits = async (top: number, height: number, bannerHeight = 0) => {
      await expectBounds(top + bannerHeight, height - bannerHeight)
      await expect.poll(async () => {
        const header = (await page.locator('.conversation-bar').boundingBox())!
        const composer = (await page.locator('.composer').boundingBox())!
        const newest = (await messages(page).last().boundingBox())!
        return {
          headerVisible: header.y >= top + bannerHeight && header.y + header.height <= top + height,
          composerBottom: composer.y + composer.height,
          newestVisible: newest.y >= header.y + header.height && newest.y + newest.height <= composer.y,
        }
      }).toEqual({ headerVisible: true, composerBottom: top + height, newestVisible: true })
      await expect.poll(() => page.locator('html').evaluate((root) => ({
        top: root.ownerDocument.scrollingElement!.scrollTop,
        height: root.ownerDocument.scrollingElement!.scrollHeight,
      }))).toEqual({ top: 0, height: 844 })
      await expect(input).toBeFocused()
    }

    await changeViewport(500, 344, 'resize')
    await expectConversationFits(344, 500)
    await expect(layout).toHaveCSS('padding-bottom', '0px')
    await changeViewport(500, 300, 'scroll')
    await expectConversationFits(300, 500)

    // Pinch zoom must not resize or move the app.
    await page.evaluate(`
      Object.assign(window.visualViewport, { height: 250, offsetTop: 400, scale: 2 });
      window.visualViewport.dispatchEvent(new Event('resize'));
    `)
    await page.evaluate('new Promise(requestAnimationFrame)')
    await expectBounds(300, 500)
    await page.evaluate('Object.assign(window.visualViewport, { scale: 1 })')
    await changeViewport(844, 0, 'resize')
    await expectConversationFits(0, 844)
    await expect.poll(() => page.locator('html').evaluate(
      (root) => root.style.getPropertyValue('--safe-bottom'),
    )).toBe('')

    // A wrapped live-location banner must leave room for the whole conversation.
    await page.context().grantPermissions(['geolocation'])
    await page.context().setGeolocation({ latitude: 48.8584, longitude: 2.2945 })
    await page.getByRole('button', { name: 'Add attachment' }).click()
    await page.getByRole('menuitem', { name: 'Location', exact: true }).click()
    await page.getByRole('dialog', { name: 'Share this location?' }).getByRole('button', { name: '15 min' }).click()
    const banner = page.getByRole('status', { name: 'Sharing live location' })
    await expect(banner).toBeVisible()
    const bannerHeight = (await banner.boundingBox())!.height
    expect(bannerHeight).toBeGreaterThan(44)
    await input.fill('Typing while sharing live location')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(messages(page).last()).toContainText('Typing while sharing live location')
    await changeViewport(500, 344, 'resize')
    await expectConversationFits(344, 500, bannerHeight)
    await expect.poll(async () => (await banner.boundingBox())!.y).toBe(344)
    await banner.getByRole('button', { name: 'Stop' }).click()
    await expect(banner).toBeHidden()
    await input.focus()
    await expectConversationFits(344, 500)
    await expect.poll(() => page.locator('html').evaluate(
      (root) => root.style.getPropertyValue('--live-banner-height'),
    )).toBe('')
  })
})

import { expect, test } from '@playwright/test'
import { randomPhone, signUp } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('asks to keep data on this device, and warns if refused (FR-PLAT-3)', async ({ browser, browserName }) => {
  // Firefox answers persist() with a permission prompt headless tests can't click.
  test.skip(browserName !== 'chromium', 'Chromium answers persist() without a prompt')
  const page = await signUp(browser, 'Pat', randomPhone())
  const storage = page.getByRole('region', { name: 'Storage' })
  await expect(storage).toContainText('Keep your keys and messages safe')
  await storage.getByRole('button', { name: 'Keep data on this device' }).click()
  // Granted: the banner goes. Refused: it turns into a warning.
  await expect(storage.getByRole('button')).toHaveCount(0)
  if (await storage.isVisible()) await expect(storage).toContainText('may delete')
})

import { expect, test } from './fixtures'
import { fixtureAction, openFixture } from './interaction-fixture-support'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts with the isolated in-memory UI fixture')

// UI contracts only. MLS transport and authenticated worker leases have separate Rust and core tests.
test('coarse activity renders accessible plain text, falls back safely, expires and never creates history', async ({ page }) => {
  await openFixture(page)
  const status = page.getByRole('status').filter({ hasText: 'Bob is ' })
  const activity = (value: Record<string, unknown>) => fixtureAction(page, 'activity', JSON.stringify({ active: true, ...value }))
  await expect(page.getByTestId('message')).toHaveCount(0)

  await activity({ activity: 'thinking' })
  await expect(status).toHaveText('Bob is thinking…')
  await expect(status).toHaveAttribute('aria-live', 'polite')
  await activity({ activity: 'using', tool: 'functions.read_v2:local' })
  await expect(status).toHaveText('Bob is using functions.read_v2:local…')
  await expect(status.locator('*')).toHaveCount(0)
  await activity({ activity: 'working' })
  await expect(status).toHaveText('Bob is working…')

  await activity({ activity: 'using', tool: '<img src=x onerror=alert(1)>' })
  await expect(status).toHaveText('Bob is typing…')
  await expect(status.locator('img, script')).toHaveCount(0)
  await activity({ activity: 'thinking' })
  await expect(status).toHaveText('Bob is thinking…')
  await activity({ activity: 'future-state' })
  await expect(status).toHaveText('Bob is typing…')
  await activity({ activity: 'using', tool: 'read' })
  await expect(status).toHaveText('Bob is using read…')
  await activity({ activity: 'using', tool: 'x'.repeat(65) })
  await expect(status).toHaveText('Bob is typing…')

  await activity({ activity: 'working', ttlMs: 1500 })
  await expect(status).toHaveText('Bob is working…')
  await expect(status).toHaveCount(0)
  await activity({ activity: 'using', tool: 'read' })
  await expect(status).toHaveText('Bob is using read…')
  await activity({ active: false, activity: 'thinking' })
  await expect(status).toHaveCount(0)
  await expect(page.getByTestId('message')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('')
})

test('maximum-length tool identifiers fit a narrow phone without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await openFixture(page)
  const tool = 'x'.repeat(64)
  await fixtureAction(page, 'activity', JSON.stringify({ active: true, activity: 'using', tool }))
  const status = page.getByRole('status').filter({ hasText: 'Bob is using ' })
  await expect(status).toHaveText(`Bob is using ${tool}…`)
  await expect.poll(() => status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect.poll(() => status.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const container = element.closest('.typing-controls')!.getBoundingClientRect()
    return bounds.left >= Math.max(container.left, 0) - 1 && bounds.right <= Math.min(container.right, window.innerWidth) + 1
  })).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

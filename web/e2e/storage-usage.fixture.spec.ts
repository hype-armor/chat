import { type Locator, type Page, expect, test } from './fixtures'
import { expectLayout } from './layout'

// Keep the Node E2E project separate from browser-only protocol dependencies.
type StorageUsage = { usedBytes: number; reservedBytes: number; limitBytes: number | null }

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; this suite tests the in-memory UI fixture')

// This fixture controls fake worker replies. It does not replace HTTP responses,
// add UI networking, or claim coverage of authentication or server accounting.
type StorageFixture = {
  storageRequests(): number
  storagePending(): boolean
  resolveStorage(usage: StorageUsage): void
  rejectStorage(): void
}
const MiB = 1024 ** 2
const finite: StorageUsage = { usedBytes: 4 * MiB, reservedBytes: MiB, limitBytes: 10 * MiB }

async function requestState(page: Page) {
  return page.evaluate(() => {
    const fixture = (window as unknown as { interactionFixture: StorageFixture }).interactionFixture
    return { requests: fixture.storageRequests(), pending: fixture.storagePending() }
  })
}
async function resolveUsage(page: Page, usage: StorageUsage) {
  await page.evaluate((usage) => {
    (window as unknown as { interactionFixture: StorageFixture }).interactionFixture.resolveStorage(usage)
  }, usage)
}
async function rejectUsage(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { interactionFixture: StorageFixture }).interactionFixture.rejectStorage()
  })
}
async function openSettings(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 320 ? 640 : 844 })
  await page.emulateMedia({ colorScheme: width === 320 ? 'dark' : 'light' })
  // A UI fixture must never contact a chat server, including on refresh.
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto('/e2e/interactions-fixture.html?room=storage-usage')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Server storage', exact: true })
  await expect(panel).toBeVisible()
  await expect.poll(() => requestState(page)).toEqual({ requests: 1, pending: true })
  await panel.scrollIntoViewIfNeeded()
  return panel
}
function amount(panel: Locator, label: string) {
  return panel.locator('.storage-totals > div').filter({ has: panel.page().getByText(label, { exact: true }) }).locator('dd')
}
async function expectPanelLayout(page: Page, panel: Locator, label: string) {
  await panel.scrollIntoViewIfNeeded()
  await expectLayout(page, label, true)
  await expect.poll(() => panel.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return [...element.querySelectorAll('h4, button, dt, dd, progress, p')].every((child) => {
      const box = child.getBoundingClientRect()
      return box.left >= bounds.left - 1 && box.right <= bounds.right + 1
        && child.scrollWidth <= child.clientWidth + 1
    })
  }), { message: `${label}: labels, values, notices, and controls must fit the panel` }).toBe(true)
  const refresh = panel.getByRole('button', { name: 'Refresh server storage', exact: true })
  await refresh.scrollIntoViewIfNeeded()
  await expect(refresh).toBeInViewport()
  expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await expect(page.getByTestId('fixture-error')).toHaveCount(0)
}

for (const width of [320, 390]) {
  test(`server storage loading, finite quotas, and unlimited quota fit at ${width}px`, async ({ page }, testInfo) => {
    const panel = await openSettings(page, width)
    const refresh = panel.getByRole('button', { name: 'Refresh server storage', exact: true })
    const progress = panel.getByRole('progressbar', { name: 'Server storage including upload reservations' })
    await expect(panel.getByRole('status')).toHaveText('Loading storage…')
    await expect(refresh).toBeDisabled()
    await expect(panel.locator('.storage-totals')).toHaveCount(0)
    await expectPanelLayout(page, panel, `initial storage loading at ${width}px`)

    await resolveUsage(page, finite)
    await expect(panel.getByRole('status')).toHaveText('Latest server snapshot')
    await expect(amount(panel, 'Used')).toHaveText('4 MiB')
    await expect(amount(panel, 'Reserved for uploads')).toHaveText('1 MiB')
    await expect(amount(panel, 'Account quota')).toHaveText('10 MiB')
    await expect(progress).toHaveAttribute('max', String(10 * MiB))
    await expect(progress).toHaveAttribute('value', String(5 * MiB))
    await expect(panel.getByRole('note')).toHaveCount(0)
    await expectPanelLayout(page, panel, `finite storage at ${width}px`)

    const cases = [
      { usedBytes: 8 * MiB, reservedBytes: MiB, limitBytes: 10 * MiB, notice: 'Storage is almost full.', progress: 9 * MiB },
      { usedBytes: 9 * MiB, reservedBytes: MiB, limitBytes: 10 * MiB, notice: 'Storage quota reached.', progress: 10 * MiB },
      { usedBytes: 10 * MiB, reservedBytes: MiB, limitBytes: 10 * MiB, notice: 'Storage quota exceeded.', progress: 10 * MiB },
      { usedBytes: 8 * 1024 ** 4, reservedBytes: MiB, limitBytes: null, notice: undefined, progress: undefined },
      { usedBytes: 0, reservedBytes: 0, limitBytes: 0, notice: 'Storage quota reached.', progress: 1 },
    ]
    for (const [index, entry] of cases.entries()) {
      await refresh.click()
      await expect.poll(() => requestState(page)).toEqual({ requests: index + 2, pending: true })
      await expect(panel.getByRole('status')).toHaveText('Refreshing storage…')
      await expect(panel.getByText('Showing the last loaded usage.', { exact: true })).toBeVisible()
      await expect(refresh).toBeDisabled()
      await resolveUsage(page, { usedBytes: entry.usedBytes, reservedBytes: entry.reservedBytes, limitBytes: entry.limitBytes })
      await expect(refresh).toBeEnabled()
      await expect(panel.getByRole('status')).toHaveText('Latest server snapshot')
      await expect(panel.getByText('Showing the last loaded usage.', { exact: true })).toHaveCount(0)
      if (entry.notice) await expect(panel.getByRole('note')).toContainText(entry.notice)
      else await expect(panel.getByRole('note')).toHaveCount(0)
      if (entry.progress !== undefined) await expect(progress).toHaveAttribute('value', String(entry.progress))
      else {
        await expect(amount(panel, 'Account quota')).toHaveText('Unlimited')
        await expect(amount(panel, 'Used')).toHaveText('8 TiB')
        await expect(progress).toHaveCount(0)
      }
      await expectPanelLayout(page, panel, `${entry.notice ?? 'unlimited'} at ${width}px`)
    }
    await testInfo.attach(`storage-${width}.png`, { body: await panel.screenshot(), contentType: 'image/png' })
  })

  test(`server storage errors, retry, and stale refresh remain usable at ${width}px`, async ({ page }) => {
    const panel = await openSettings(page, width)
    const refresh = panel.getByRole('button', { name: 'Refresh server storage', exact: true })
    await rejectUsage(page)
    await expect(panel.getByRole('alert')).toHaveText('Could not load server storage. Try again.')
    await expect(panel.getByRole('status')).toHaveText('Storage usage unavailable')
    await expect(panel.locator('.storage-totals')).toHaveCount(0)
    await expect(refresh).toBeEnabled()
    await expectPanelLayout(page, panel, `initial storage error at ${width}px`)

    // A keyboard user can activate retry without using a pointer.
    await refresh.focus()
    await refresh.press('Enter')
    await expect.poll(() => requestState(page)).toEqual({ requests: 2, pending: true })
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel.getByRole('status')).toHaveText('Loading storage…')
    await resolveUsage(page, finite)
    await expect(amount(panel, 'Used')).toHaveText('4 MiB')
    await expect(refresh).toBeEnabled()

    await refresh.focus()
    await refresh.press('Enter')
    await expect.poll(() => requestState(page)).toEqual({ requests: 3, pending: true })
    await expect(panel.getByRole('status')).toHaveText('Refreshing storage…')
    await expect(amount(panel, 'Reserved for uploads')).toHaveText('1 MiB')
    await expect(panel.getByText('Showing the last loaded usage.', { exact: true })).toBeVisible()
    await expect(refresh).toBeDisabled()
    await rejectUsage(page)
    await expect(panel.getByRole('alert')).toBeVisible()
    await expect(amount(panel, 'Used')).toHaveText('4 MiB')
    await expect(amount(panel, 'Account quota')).toHaveText('10 MiB')
    await expect(panel.getByText('Showing the last loaded usage.', { exact: true })).toBeVisible()
    await expectPanelLayout(page, panel, `failed storage refresh at ${width}px`)

    await refresh.click()
    await expect.poll(() => requestState(page)).toEqual({ requests: 4, pending: true })
    await resolveUsage(page, { usedBytes: 2 * MiB, reservedBytes: 0, limitBytes: null })
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel.getByRole('status')).toHaveText('Latest server snapshot')
    await expect(amount(panel, 'Used')).toHaveText('2 MiB')
    await expect(amount(panel, 'Reserved for uploads')).toHaveText('0 B')
    await expect(amount(panel, 'Account quota')).toHaveText('Unlimited')
    await expect(panel.getByRole('progressbar')).toHaveCount(0)
    await expect(panel.getByText('Showing the last loaded usage.', { exact: true })).toHaveCount(0)
    await expectPanelLayout(page, panel, `storage retry recovery at ${width}px`)
  })
}

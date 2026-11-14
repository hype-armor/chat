import { expect, test, type Page } from './fixtures'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts with isolated UI fixtures')

type PermissionFixture = {
  snapshot(): { requests: number; stops: number; recordings: number; sent: number }
  resolve(): void
  reject(): void
  failRecorder(): void
  locationRequests(): number
  resolveLocation(): void
  rejectLocation(): void
  restore(): void
}
async function snapshot(page: Page) {
  return page.evaluate(() => (window as unknown as { permissionFixture: PermissionFixture }).permissionFixture.snapshot())
}
async function action(page: Page, method: 'resolve' | 'reject' | 'failRecorder' | 'restore' | 'resolveLocation' | 'rejectLocation') {
  await page.evaluate((method) => (window as unknown as { permissionFixture: PermissionFixture }).permissionFixture[method](), method)
}

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto('/e2e/permissions-fixture.html')
  await expect(page.getByRole('button', { name: 'Record a voice note', exact: true })).toBeVisible()
  expect(await snapshot(page)).toEqual({ requests: 0, stops: 0, recordings: 0, sent: 0 })
})
test.afterEach(async ({ page }) => {
  // Each fixture restores every instrumented browser API, including on failure.
  await action(page, 'restore')
})

test('rapid recorder clicks request once and a late grant stops after removal', async ({ page }) => {
  await page.getByRole('button', { name: 'Record a voice note', exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })
  expect((await snapshot(page)).requests).toBe(1)
  await expect(page.getByRole('button', { name: 'Record a voice note', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Remove recorder', exact: true }).click()
  await action(page, 'resolve')
  await expect.poll(() => snapshot(page)).toEqual({ requests: 1, stops: 1, recordings: 0, sent: 0 })
})

test('recorder startup failure releases the microphone', async ({ page }) => {
  await action(page, 'failRecorder')
  await page.getByRole('button', { name: 'Record a voice note', exact: true }).click()
  await action(page, 'resolve')
  await expect(page.getByRole('alert')).toHaveText('Recorder startup failed')
  await expect.poll(() => snapshot(page)).toEqual({ requests: 1, stops: 1, recordings: 0, sent: 0 })
})

test('cancel recording releases active tracks and never sends', async ({ page }) => {
  await page.getByRole('button', { name: 'Record a voice note', exact: true }).click()
  await action(page, 'resolve')
  await expect(page.getByRole('status', { name: 'Recording a voice note', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Record a voice note', exact: true })).toBeEnabled()
  await expect.poll(() => snapshot(page)).toEqual({ requests: 1, stops: 1, recordings: 1, sent: 0 })
})

test('StrictMode scanner mount and callback changes do not repeat requests', async ({ page }) => {
  await page.getByRole('button', { name: 'Open scanner', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).requests).toBe(1)
  await page.getByRole('button', { name: 'Render again', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Revision', exact: true })).toHaveText('1')
  expect((await snapshot(page)).requests).toBe(1)
  await page.getByRole('button', { name: 'Remove scanner', exact: true }).click()
  await action(page, 'resolve')
  await expect.poll(() => snapshot(page)).toEqual({ requests: 1, stops: 1, recordings: 0, sent: 0 })
})

test('scanner stops its active camera on removal', async ({ page }) => {
  await page.getByRole('button', { name: 'Open scanner', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).requests).toBe(1)
  await action(page, 'resolve')
  await page.getByRole('button', { name: 'Remove scanner', exact: true }).click()
  await expect.poll(() => snapshot(page)).toEqual({ requests: 1, stops: 1, recordings: 0, sent: 0 })
})

test('denial explains browser settings and does not retry automatically', async ({ page }) => {
  await page.getByRole('button', { name: 'Record a voice note', exact: true }).click()
  await action(page, 'reject')
  await expect(page.getByRole('alert')).toContainText("this site's browser settings")
  await expect(page.getByRole('alert')).toContainText('temporary grants or private browsing')
  expect((await snapshot(page)).requests).toBe(1)
})

async function locationRequests(page: Page) {
  return page.evaluate(() => (window as unknown as { permissionFixture: PermissionFixture }).permissionFixture.locationRequests())
}

test('rapid location actions request once and denial explains browser settings', async ({ page }) => {
  expect(await locationRequests(page)).toBe(0)
  await page.getByRole('button', { name: 'Find location', exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })
  expect(await locationRequests(page)).toBe(1)
  await action(page, 'rejectLocation')
  await expect(page.getByRole('alert')).toContainText('Cannot access your location.')
  await expect(page.getByRole('alert')).toContainText("this site's browser settings")
  expect(await locationRequests(page)).toBe(1)
})

test('a late location result cannot open a dialog after removal', async ({ page }) => {
  await page.getByRole('button', { name: 'Find location', exact: true }).click()
  expect(await locationRequests(page)).toBe(1)
  await page.getByRole('button', { name: 'Remove location', exact: true }).click()
  await action(page, 'resolveLocation')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

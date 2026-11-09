import { expect, test, type Locator, type Page } from './fixtures'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; synthetic location preview only')
type PreviewFixture = { failMaps(): void; denyNext(): void; sends(): number; restore(): void }
async function fixtureAction(page: Page, method: 'failMaps' | 'denyNext' | 'restore') {
  await page.evaluate((method) => (window as unknown as { locationPreviewFixture: PreviewFixture }).locationPreviewFixture[method](), method)
}
async function controls(preview: Locator) {
  const buttons = preview.locator('.actions').getByRole('button')
  await expect(buttons).toHaveText(['Send location', '15 min', '1 hour', '8 hours', 'Until stopped', 'Cancel'])
  const boxes = []
  for (const button of await buttons.all()) {
    // Do not scroll controls into view: all 6 must fit together at rest.
    await expect(button).toBeInViewport({ ratio: 1 })
    await expect(button).toHaveCSS('white-space', 'nowrap')
    const box = (await button.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    boxes.push(box)
  }
  const group = (await preview.getByRole('group', { name: 'Share live location for' }).boundingBox())!
  for (const box of [boxes[0], boxes[5]]) {
    expect(Math.abs(box.x - group.x)).toBeLessThan(1)
    expect(Math.abs(box.width - group.width)).toBeLessThan(1)
  }
  expect(Math.abs(boxes[1].y - boxes[2].y)).toBeLessThan(1)
  expect(Math.abs(boxes[3].y - boxes[4].y)).toBeLessThan(1)
  expect(boxes[3].y).toBeGreaterThan(boxes[1].y)
  return boxes
}
test.beforeEach(async ({ page }) => {
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto('/e2e/location-preview-fixture.html')
  await expect(page.getByRole('button', { name: 'Preview location', exact: true })).toBeVisible()
})
test.afterEach(async ({ page }) => { await fixtureAction(page, 'restore') })

for (const { width, height } of [
  { width: 320, height: 720 }, { width: 390, height: 720 },
  { width: 768, height: 720 }, { width: 1280, height: 720 },
]) {
  test(`all location preview actions fit at ${width}x${height} before and after map failure`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const trigger = page.getByRole('button', { name: 'Preview location', exact: true })
    await trigger.click()
    const preview = page.getByRole('dialog', { name: 'Share this location?', exact: true })
    await expect(preview).toBeVisible()
    const map = preview.getByTestId('map')
    const originalMap = (await map.boundingBox())!
    expect(originalMap.height).toBeCloseTo(224, 2)
    const before = await controls(preview)
    await fixtureAction(page, 'failMaps')
    await expect(map).toContainText("The map can't be shown in this browser.")
    const afterMap = (await map.boundingBox())!
    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      expect(afterMap[dimension]).toBeCloseTo(originalMap[dimension], 2)
    }
    const after = await controls(preview)
    for (let i = 0; i < before.length; i++) {
      for (const dimension of ['x', 'y', 'width', 'height'] as const) {
        expect(after[i][dimension]).toBeCloseTo(before[i][dimension], 2)
      }
    }
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(preview).toBeHidden()
    await expect(trigger).toBeFocused()
    expect(await page.evaluate(() => (window as unknown as { locationPreviewFixture: PreviewFixture }).locationPreviewFixture.sends())).toBe(0)
  })
}

test('denied location access keeps accessible browser and device permission guidance', async ({ page }) => {
  await fixtureAction(page, 'denyNext')
  await page.getByRole('button', { name: 'Preview location', exact: true }).click()
  const error = page.getByRole('alert')
  await expect(error).toContainText('Cannot access your location.')
  await expect(error).toContainText("this site's browser settings and your device settings")
  await expect(error).toContainText('temporary grants or private browsing')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

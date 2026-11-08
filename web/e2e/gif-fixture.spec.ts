import { readFile } from 'node:fs/promises'
import { expect, test } from './fixtures'

test.skip(!process.env.E2E_UI_FIXTURES, 'requires an isolated fixture origin')

// animated.gif is a deterministic GIF89a: red and blue 1-pixel frames,
// 300 ms each, infinite NETSCAPE2.0 loop. No external asset or service.
const gif = await readFile(new URL('./fixtures/animated.gif', import.meta.url))

test('GIF originals survive worker encryption and animate without a thumbnail', async ({ page }) => {
  await page.goto('/e2e/gif-fixture.html')
  await page.getByLabel('GIF file').setInputFiles({ name: 'animated.gif', mimeType: 'image/gif', buffer: gif })
  await expect(page.locator('output')).toContainText('"intact":true')
  await expect(page.locator('output')).toContainText('"prepared":true')
  await expect(page.locator('output')).toContainText('"thumbnail":true')
  // The render fixture deliberately omits the thumbnail.
  // openAttachment is a stub: this checks UI retry, not network/storage retry.
  await page.getByLabel('Fail download').check()
  await page.getByRole('button', { name: 'Show photo animated.gif' }).click()
  await expect(page.getByRole('alert')).toHaveText('Fixture download failed')
  await page.getByLabel('Fail download').uncheck()
  await page.getByRole('button', { name: 'Show photo animated.gif' }).click()
  const image = page.getByRole('img', { name: 'animated.gif' })
  await expect(image).toHaveAttribute('data-full', 'true')
  await expect(image).toHaveJSProperty('naturalWidth', 1)
  const first = await image.screenshot()
  await expect.poll(async () => !(await image.screenshot()).equals(first), { timeout: 5000 }).toBe(true)
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: 'Save', exact: true }).click(),
  ])
  expect(download.suggestedFilename()).toBe('animated.gif')
  expect(await readFile((await download.path())!)).toEqual(gif)
})

for (const colorScheme of ['light', 'dark'] as const) {
  for (const mine of [false, true]) {
    test(`thumbnail-free photo text has contrast: ${colorScheme}, mine=${mine}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await page.goto(`/e2e/gif-fixture.html${mine ? '?mine=1' : ''}`)
      await page.getByLabel('GIF file').setInputFiles({ name: 'animated.gif', mimeType: 'image/gif', buffer: gif })
      const button = page.getByRole('button', { name: 'Show photo animated.gif' })
      await expect(button).toBeVisible()
      const result = await button.evaluate((element) => {
        const bubble = element.closest('li')!
        const foreground = getComputedStyle(element).color
        const luminance = (css: string) => {
          const rgb = css.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((channel) => {
            const value = channel / 255
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
          })
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
        }
        const text = luminance(foreground)
        const background = luminance(getComputedStyle(bubble).backgroundColor)
        return {
          inherited: foreground === getComputedStyle(bubble).color,
          contrast: (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05),
        }
      })
      expect(result.inherited).toBe(true)
      expect(result.contrast).toBeGreaterThanOrEqual(4.5)
    })
  }
}

for (const mimeType of ['', 'application/octet-stream', 'image/svg+xml']) {
  test(`a GIF extension does not override ${mimeType || 'empty'} MIME`, async ({ page }) => {
    await page.goto('/e2e/gif-fixture.html')
    if (mimeType) {
      await page.getByLabel('GIF file').setInputFiles({ name: 'animated.gif', mimeType, buffer: gif })
    } else {
      // Playwright infers a MIME from .gif when mimeType is empty.
      await page.getByLabel('GIF file').evaluate((element, bytes) => {
        const input = element as HTMLInputElement
        const transfer = new DataTransfer()
        transfer.items.add(new File([new Uint8Array(bytes)], 'animated.gif', { type: '' }))
        input.files = transfer.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }, [...gif])
    }
    await expect(page.locator('output')).toContainText('"intact":true')
    await expect(page.locator('output')).toContainText('"prepared":false')
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible()
    await expect(page.locator('.attachment img')).toHaveCount(0)
  })
}

test('malformed GIF bytes use the existing undecodable-image boundary', async ({ page }) => {
  await page.goto('/e2e/gif-fixture.html')
  await page.getByLabel('GIF file').setInputFiles({ name: 'broken.gif', mimeType: 'image/gif', buffer: Buffer.from('not a GIF') })
  await expect(page.locator('output')).toContainText('"intact":true')
  await expect(page.locator('output')).toContainText('"prepared":false')
})

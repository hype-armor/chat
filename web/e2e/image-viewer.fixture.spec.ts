import { expect, test, type Page } from './fixtures'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts with isolated UI fixtures')

type ImageFixture = {
  created: string[]
  revoked: string[]
  requests(): number
  resolve(broken?: boolean): void
  reject(): void
  unmount(): void
  remountAccount(): void
  incoming(kind: 'direct' | 'group'): void
}
async function control(page: Page, action: 'resolve' | 'reject' | 'unmount') {
  await page.evaluate((action) => (window as unknown as { imageFixture: ImageFixture }).imageFixture[action](), action)
}
const viewer = (page: Page) => page.getByRole('dialog', { name: 'Image: Synthetic image.png', exact: true })
const trigger = (page: Page) => page.getByRole('button', { name: 'Show photo Synthetic image.png', exact: true })

for (const direction of ['sent', 'received']) {
  for (const width of [360, 1280]) {
    test(`${direction} image opens at ${width}px, traps focus, closes and reopens`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 })
      await page.goto(`/e2e/image-viewer-fixture.html?direction=${direction}&thumbnail=1`)
      await trigger(page).focus()
      await page.keyboard.press('Enter')
      const dialog = viewer(page)
      await expect(dialog).toHaveAttribute('aria-modal', 'true')
      await expect(dialog.getByRole('status')).toHaveText('Opening image…')
      const close = dialog.getByRole('button', { name: 'Close image' })
      await expect(close).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(close).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(close).toBeFocused()
      await expect(page.locator('#root')).toHaveAttribute('inert', '')
      await control(page, 'resolve')
      await expect(dialog.getByRole('img')).toBeVisible()
      await expect.poll(() => dialog.getByRole('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
      const box = (await dialog.boundingBox())!
      expect(box.x).toBe(0)
      expect(box.y).toBe(0)
      expect(box.width).toBe(width)
      expect(box.height).toBe(780)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(trigger(page)).toBeFocused()
      await expect(page.locator('#root')).not.toHaveAttribute('inert')
      const source = await page.locator('.photo img').getAttribute('src')
      await trigger(page).click()
      await expect(dialog.getByRole('img')).toHaveAttribute('src', source!)
      expect(await page.evaluate(() => (window as unknown as { imageFixture: ImageFixture }).imageFixture.requests())).toBe(1)
      await close.click()
      await expect(trigger(page)).toBeFocused()
    })
  }
}

test('downloaded photos stay interactive and retain the full source until unmount', async ({ page }) => {
  await page.goto('/e2e/image-viewer-fixture.html?downloaded=1')
  await expect.poll(() => page.evaluate(() => (window as unknown as { imageFixture: ImageFixture }).imageFixture.requests())).toBe(1)
  await control(page, 'resolve')
  await expect(page.locator('.photo img')).toHaveAttribute('data-full', 'true')
  await expect(trigger(page)).toBeEnabled()
  const source = (await page.locator('.photo img').getAttribute('src'))!
  await trigger(page).click()
  await page.keyboard.press('Escape')
  expect(await page.evaluate((source) => (window as unknown as { imageFixture: ImageFixture }).imageFixture.revoked.includes(source), source)).toBe(false)
  await control(page, 'unmount')
  await expect.poll(() => page.evaluate((source) => (window as unknown as { imageFixture: ImageFixture }).imageFixture.revoked.includes(source), source)).toBe(true)
})

test('StrictMode opens a downloaded photo once and fences late results across account remount', async ({ page }) => {
  await page.goto('/e2e/image-viewer-fixture.html?strict=1&downloaded=1')
  const requests = () => page.evaluate(() => (window as unknown as { imageFixture: ImageFixture }).imageFixture.requests())
  await expect.poll(requests).toBe(1)
  await control(page, 'unmount')
  await expect(page.getByTestId('attachment')).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { imageFixture: ImageFixture }).imageFixture.remountAccount())
  await expect.poll(requests).toBe(2)
  await control(page, 'resolve') // The previous account's request finishes late.
  await expect(page.locator('.photo img')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { imageFixture: ImageFixture }).imageFixture.created)).toEqual([])
  await control(page, 'resolve')
  await expect(page.locator('.photo img')).toHaveAttribute('data-full', 'true')
  await trigger(page).click()
  await expect(viewer(page).getByRole('img')).toBeVisible()
  await page.keyboard.press('Escape')
  const source = (await page.locator('.photo img').getAttribute('src'))!
  await control(page, 'unmount')
  await expect.poll(() => page.evaluate((source) => (window as unknown as { imageFixture: ImageFixture }).imageFixture.revoked.includes(source), source)).toBe(true)
})

test('a failed worker request supports retry without duplicate requests', async ({ page }) => {
  await page.goto('/e2e/image-viewer-fixture.html')
  await trigger(page).click()
  await control(page, 'reject')
  await expect(viewer(page).getByRole('alert')).toHaveText('Synthetic image failure')
  const retry = viewer(page).getByRole('button', { name: 'Try again' })
  await page.keyboard.press('Tab')
  await expect(retry).toBeFocused()
  await page.keyboard.press('Enter')
  await control(page, 'resolve')
  await expect(viewer(page).getByRole('img')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { imageFixture: ImageFixture }).imageFixture.requests())).toBe(2)
})

test('close during loading does not reopen, and unmount discards late decrypted results', async ({ page }) => {
  await page.goto('/e2e/image-viewer-fixture.html')
  await trigger(page).click()
  await page.keyboard.press('Escape')
  await trigger(page).click()
  expect(await page.evaluate(() => (window as unknown as { imageFixture: ImageFixture }).imageFixture.requests())).toBe(1)
  await page.keyboard.press('Escape')
  await control(page, 'resolve')
  await expect(page.locator('.photo img')).toHaveAttribute('data-full', 'true')
  await expect(viewer(page)).toHaveCount(0)
  await page.reload()
  await trigger(page).click()
  await control(page, 'unmount')
  await control(page, 'resolve')
  await expect(viewer(page)).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { imageFixture: ImageFixture }).imageFixture.created)).toEqual([])
  await expect(page.locator('#root')).not.toHaveAttribute('inert')
})

test('a corrupt image shows an accessible decode error', async ({ page }) => {
  await page.goto('/e2e/image-viewer-fixture.html')
  await trigger(page).click()
  await page.evaluate(() => (window as unknown as { imageFixture: ImageFixture }).imageFixture.resolve(true))
  await expect(viewer(page).getByRole('alert')).toContainText('This image cannot be displayed')
  await page.keyboard.press('Escape')
  await expect(trigger(page)).toBeFocused()
})

for (const kind of ['direct', 'group'] as const) {
  test(`a ${kind} call dismisses the viewer and receives focus`, async ({ page }) => {
    await page.goto('/e2e/image-viewer-fixture.html')
    await trigger(page).click()
    await page.evaluate((kind) => (window as unknown as { imageFixture: ImageFixture }).imageFixture.incoming(kind), kind)
    await expect(viewer(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Dismiss synthetic call' })).toBeFocused()
    await expect(page.locator('#root')).not.toHaveAttribute('inert')
    await control(page, 'resolve')
    await expect(viewer(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Dismiss synthetic call' })).toBeFocused()
    await expect(page.getByTestId('fixture-error')).toHaveCount(0)
  })
}

test('a thumbnail-free GIF retries in the viewer and keeps its original animation', async ({ page }) => {
  await page.goto(`/e2e/image-viewer-fixture.html?${new URLSearchParams({ mime: 'image/gif', filename: 'animated.gif' })}`)
  const open = page.getByRole('button', { name: 'Show photo animated.gif', exact: true })
  await expect(open).toHaveText('Show photo animated.gif')
  await open.click()
  const dialog = page.getByRole('dialog', { name: 'Image: animated.gif', exact: true })
  await control(page, 'reject')
  await dialog.getByRole('button', { name: 'Try again' }).click()
  await control(page, 'resolve')
  const image = dialog.getByRole('img', { name: 'animated.gif', exact: true })
  await expect(image).toHaveAttribute('data-full', 'true')
  await expect(image).toHaveJSProperty('naturalWidth', 1)
  const first = await image.screenshot()
  await expect.poll(async () => !(await image.screenshot()).equals(first), { timeout: 5000 }).toBe(true)
  await page.keyboard.press('Escape')
  await expect(open).toBeFocused()
})

for (const mime of ['image/svg+xml', 'image/tiff', 'application/pdf']) {
  test(`${mime} remains a download and never enters the viewer`, async ({ page }) => {
    await page.goto(`/e2e/image-viewer-fixture.html?${new URLSearchParams({ mime, filename: 'Synthetic file.bin', downloaded: '1', thumbnail: '1' })}`)
    await expect(page.locator('.file-card')).toBeVisible()
    await expect(page.locator('.attachment img')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Show photo/ })).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { imageFixture: ImageFixture }).imageFixture.requests())).toBe(0)
    await page.getByRole('button', { name: 'Download', exact: true }).click()
    const download = page.waitForEvent('download')
    await control(page, 'resolve')
    // Browsers can adjust extensions for the Blob MIME type. WebKit also
    // replaces spaces with underscores in suggested download names.
    expect((await download).suggestedFilename()).toMatch(/^Synthetic[ _]file\./)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
}

for (const mime of ['audio/ogg', 'video/mp4']) {
  test(`${mime} keeps its inline player without an image dialog`, async ({ page }) => {
    await page.goto(`/e2e/image-viewer-fixture.html?${new URLSearchParams({ mime, filename: 'Synthetic clip' })}`)
    await page.getByRole('button', { name: 'Play Synthetic clip', exact: true }).click()
    await control(page, 'resolve')
    await expect(page.locator(mime.startsWith('audio/') ? 'audio[controls]' : 'video[controls]')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
}

test('new background notices become inert and prior inert state survives dismissal', async ({ page }) => {
  await page.goto('/e2e/image-viewer-fixture.html')
  await page.evaluate(() => {
    const old = document.createElement('button')
    old.id = 'previously-inert'
    old.inert = true
    document.body.append(old)
  })
  await trigger(page).click()
  await page.evaluate(() => {
    const notice = document.createElement('button')
    notice.id = 'new-notice'
    notice.textContent = 'New notice'
    document.body.append(notice)
  })
  await expect(page.locator('#new-notice')).toHaveAttribute('inert', '')
  await page.keyboard.press('Escape')
  await expect(page.locator('#new-notice')).not.toHaveAttribute('inert')
  await expect(page.locator('#previously-inert')).toHaveAttribute('inert', '')
})

import { expect, test } from '@playwright/test'

test('MLS core runs in the browser', async ({ page }) => {
  await page.goto('/#diagnostics')
  await expect(page.getByTestId('self-test')).toHaveText('passed')
})

test('50-member group commit benchmark completes', async ({ page }) => {
  await page.goto('/#diagnostics')
  // Wait until the page has settled: the sign-up form replaces "Loading…"
  // above the diagnostics panel and shifts the Run button down.
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible()
  await expect(page.getByTestId('self-test')).toHaveText('passed')
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByTestId('bench')).toContainText('50', { timeout: 60_000 })
})

test('signed-out visitors see phone sign-up', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('Phone number')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible()
})

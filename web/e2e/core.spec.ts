import { expect, test } from '@playwright/test'

test('MLS core runs in the browser', async ({ page }) => {
  await page.goto('/#diagnostics')
  await expect(page.getByTestId('self-test')).toHaveText('passed')
})

test('50-member group commit benchmark completes', async ({ page }) => {
  // Building 49 key packages and a 50-member group takes a while in slower
  // engines on busy CI runners; the default 30 s test limit is too tight.
  test.setTimeout(90_000)
  await page.goto('/#diagnostics')
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByTestId('bench')).toContainText('50', { timeout: 60_000 })
})

test('signed-out visitors see phone sign-up', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('Phone number')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible()
})

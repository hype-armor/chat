import { expect, test } from '@playwright/test'

test('MLS core runs in the browser', async ({ page }) => {
  await page.goto('/#diagnostics')
  await expect(page.getByTestId('self-test')).toHaveText('passed')
})

test('50-member group commit benchmark completes', async ({ page }) => {
  await page.goto('/#diagnostics')
  await expect(page.getByTestId('self-test')).toHaveText('passed')
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByTestId('bench')).toContainText('50', { timeout: 60_000 })
})

test('signed-out visitors see sign-up', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('Username')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible()
  await expect(page.getByRole('contentinfo')).toHaveCount(0)
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click()
  await expect(page.getByTestId('self-test')).toHaveText('passed')
  await page.getByRole('button', { name: '← Back', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible()
})

test('diagnostics follows hash navigation and can return to onboarding', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible()
  await page.evaluate("location.hash = 'diagnostics'")
  await expect(page.getByTestId('self-test')).toHaveText('passed')
  await page.getByRole('button', { name: '← Back', exact: true }).click()
  await expect(page).not.toHaveURL(/#diagnostics$/)
  await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible()
})

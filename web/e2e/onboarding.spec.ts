import { expect, test } from '@playwright/test'

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test(`onboarding card at ${width}px in ${colorScheme} mode`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme })
      await page.goto('/')
      const card = page.getByRole('main')
      await expect(card.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible()
      await expect(card.locator('img')).toHaveAttribute('src', '/icon.svg')
      await expect(card).toContainText('End-to-end encrypted. The server never sees your messages.')
      await expect(page.getByLabel('Your name', { exact: true })).toHaveAttribute('required', '')
      await expect(page.getByLabel('Username', { exact: true })).toHaveAttribute('required', '')
      await expect(page.getByLabel('Invite code')).not.toHaveAttribute('required')
      await expect(card).toContainText('Optional on open servers')
      await expect(page.getByLabel('Username')).toHaveAccessibleDescription(/People add you by your username/)
      await expect(page.getByRole('region', { name: 'Other ways to get started' })).toBeVisible()
      const bounds = (await card.boundingBox())!
      expect(bounds.width).toBeLessThanOrEqual(384)
      expect(bounds.x + bounds.width / 2).toBeCloseTo(width / 2, 0)
      expect(await page.evaluate('document.documentElement.scrollWidth')).toBe(width)

      await page.getByLabel('Your name').fill('Dana Lee')
      await page.keyboard.press('Tab')
      await expect(page.getByLabel('Username')).toBeFocused()
      await expect(page.getByLabel('Username')).toHaveValue(/^danalee\.\d{2}$/)
      await page.getByLabel('Username').fill('chosen.42')
      await page.getByLabel('Your name').fill('New name')
      await page.getByLabel('Your name').blur()
      await expect(page.getByLabel('Username')).toHaveValue('chosen.42')
      await page.getByRole('button', { name: /Restore from backup/ }).click()
      await expect(page.getByLabel('Recovery key')).toBeVisible()
      await page.getByRole('button', { name: 'Back', exact: true }).click()
      await expect(page.getByLabel('Username')).toHaveValue('chosen.42')
      await page.getByRole('button', { name: 'Diagnostics', exact: true }).click()
      await expect(page.getByTestId('self-test')).toHaveText('passed')
    })
  }
}

for (const { message, field, status } of [
  { message: 'that username is taken', field: 'Username', status: 409 },
  { message: 'username must look like name.42: 3-20 letters, digits or _, a dot and 2-4 digits', field: 'Username', status: 400 },
  { message: 'this invite is not valid: it was used, expired or mistyped', field: 'Invite code', status: 403 },
  { message: 'sign-up needs an invite', field: 'Invite code', status: 403 },
]) {
  test(`associates "${message}" with its field and clears it on editing`, async ({ page }) => {
    await page.context().route('**/v1/register', (route) =>
      route.fulfill({ status, json: { error: message } }),
    )
    await page.goto('/#invite=prefilled-code')
    await expect(page.getByLabel('Invite code')).toHaveValue('prefilled-code')
    await page.getByLabel('Username').fill('dana.42')
    await page.getByLabel('Your name').fill('Dana')
    await page.getByRole('button', { name: 'Sign up' }).click()
    await expect(page.getByRole('alert')).toHaveText(message)
    const input = page.getByLabel(field, { exact: true })
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(input).toHaveAccessibleDescription(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    if (message === 'sign-up needs an invite') {
      await expect(input).toHaveAttribute('required', '')
    }
    await input.fill(field === 'Username' ? 'other.42' : 'another-code')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(input).not.toHaveAttribute('aria-invalid')
    await expect(page.getByRole('button', { name: 'Sign up' })).toBeEnabled()
  })
}

test('keeps unknown failures at form level and clears them when changing flows', async ({ page }) => {
  await page.context().route('**/v1/register', (route) =>
    route.fulfill({ status: 503, json: { error: 'service temporarily unavailable' } }),
  )
  await page.goto('/')
  await page.getByLabel('Username').fill('dana.42')
  await page.getByLabel('Your name').fill('Dana')
  await page.getByRole('button', { name: 'Sign up' }).click()
  await expect(page.getByRole('alert')).toHaveText('service temporarily unavailable')
  await expect(page.locator('input[aria-invalid="true"]')).toHaveCount(0)
  await page.getByRole('button', { name: /Restore from backup/ }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByLabel('Recovery key')).toBeVisible()
})

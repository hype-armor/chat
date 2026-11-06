import { type Page, expect } from '@playwright/test'

export async function openFixture(page: Page, name = 'Alice', room = 'single') {
  // Block all transport requests. A fixture test must never reach a chat server.
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto(`/e2e/interactions-fixture.html?${new URLSearchParams({ name, room })}`)
  await page.getByRole('button', { name: name === 'Alice' ? /Bob/ : /Alice/ }).click()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
  await expect(page.getByTestId('fixture-error')).toHaveCount(0)
}

export async function fixtureAction(page: Page, method: 'seed' | 'incoming' | 'missingReply' | 'dropTypingStops' | 'holdNextSend' | 'rejectSend', value?: string | number) {
  await page.evaluate(({ method, value }) => {
    const fixture = (window as unknown as {
      interactionFixture: Record<string, (value?: string | number) => void>
    }).interactionFixture
    fixture[method](value)
  }, { method, value })
}

export async function fixtureSend(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('message').filter({ hasText: text }).last()).toContainText(text)
}

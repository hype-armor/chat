import { type Locator, type Page, expect } from '@playwright/test'

export async function replyToMessage(page: Page, message: Locator) {
  await message.focus()
  await message.press('Shift+F10')
  await page.getByRole('menu', { name: 'Message actions', exact: true }).getByRole('menuitem', { name: 'Reply', exact: true }).click()
}

export async function openFixture(page: Page, name = 'Alice', room = 'single') {
  // Block all transport requests. A fixture test must never reach a chat server.
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto(`/e2e/interactions-fixture.html?${new URLSearchParams({ name, room })}`)
  await page.getByRole('button', { name: name === 'Alice' ? /Bob/ : /Alice/ }).click()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
  await expect(page.getByTestId('fixture-error')).toHaveCount(0)
}

export async function fixtureAction(page: Page, method: 'seed' | 'incoming' | 'legacyMessage' | 'makeReplyAvailable' | 'missingReply' | 'dropTypingStops' | 'holdNextSend' | 'rejectSend' | 'acceptSend' | 'seedDraft' | 'failDraftLoad' | 'failDraftSave' | 'conflictDraftSave' | 'holdDraftLoad' | 'releaseDraftLoad' | 'holdDraftSave' | 'releaseDraftSave' | 'restartUI' | 'addChat', value?: string | number) {
  await page.evaluate(({ method, value }) => {
    const fixture = (window as unknown as {
      interactionFixture: Record<string, (value?: string | number) => void>
    }).interactionFixture
    fixture[method](value)
  }, { method, value })
}

export async function fixtureDraft(page: Page, id = 'chat') {
  return page.evaluate((id) => (window as unknown as { interactionFixture: { draft(id: string): { text: string; revision: number } } }).interactionFixture.draft(id), id)
}

export async function fixturePending(page: Page, kind: 'send' | 'load' | 'save') {
  const method = kind === 'send' ? 'pendingSend' : kind === 'load' ? 'draftLoadPending' : 'draftSavePending'
  return page.evaluate((method) => (window as unknown as { interactionFixture: Record<string, () => boolean> }).interactionFixture[method](), method)
}

export async function fixtureSend(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('message').filter({ hasText: text }).last()).toContainText(text)
}

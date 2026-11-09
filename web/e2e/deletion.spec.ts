import { test, expect, type Page, type Locator } from './fixtures'

test.skip(!process.env.E2E_UI_FIXTURES, 'runs only in the isolated UI fixture project')

async function action(page: Page, method: string, value?: unknown) {
  await page.evaluate(({ method, value }) => {
    (window as unknown as { interactionFixture: Record<string, (value?: unknown) => unknown> }).interactionFixture[method](value)
  }, { method, value })
}
async function open(page: Page, width = 390) {
  await page.setViewportSize({ width, height: 720 })
  await page.route('**/v1/**', (route) => route.abort('blockedbyclient'))
  await page.goto('/e2e/interactions-fixture.html?deletion=1&reactions=1')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
}
async function menu(page: Page, row: Locator, scope: 'me' | 'everyone') {
  await row.focus()
  await expect(row).toBeFocused()
  await row.press('Shift+F10')
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('menuitem', { name: `Delete for ${scope}`, exact: true }).click()
  return page.getByRole('dialog', { name: `Delete for ${scope}?`, exact: true })
}

for (const width of [390, 1024]) {
  test(`deletion confirmation contains focus and cancels without changing the draft (${width}px)`, async ({ page }) => {
    await open(page, width)
    await action(page, 'ownDeletionMessage')
    const row = page.getByTestId('message').last()
    await page.getByLabel('Message', { exact: true }).fill('Keep my draft')
    const dialog = await menu(page, row, 'everyone')
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    await expect(cancel).toBeFocused()
    await cancel.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: 'Delete for everyone', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(cancel).toBeFocused()
    await expect(dialog).toContainText('does not confirm remote erasure')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(row).toBeFocused()
    await expect(row).toContainText('Own deletion target')
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my draft')
  })
}

test('incoming and legacy messages have device deletion independent of reply eligibility', async ({ page }) => {
  await open(page)
  await action(page, 'legacyMessage')
  const row = page.getByTestId('message').last()
  await row.focus(); await row.press('Shift+F10')
  await expect(page.getByRole('menuitem', { name: 'Reply', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Delete for everyone', exact: true })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Delete for me', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('only from this device')
  await dialog.getByRole('button', { name: 'Delete for me', exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Conversation with Bob', exact: true })).toBeFocused()
  await action(page, 'incoming', 'Incoming own-author protection')
  const incoming = page.getByTestId('message').last()
  await incoming.focus(); await incoming.press('Shift+F10')
  await expect(page.getByRole('menuitem', { name: 'Delete for everyone', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Delete for me', exact: true })).toBeVisible()
})

for (const author of ['own', 'incoming'] as const) {
  test(`verified ${author} Me confirmation names own linked devices and excludes other people`, async ({ page }) => {
    await open(page)
    if (author === 'own') await action(page, 'ownDeletionMessage')
    else await action(page, 'incoming', 'Verified incoming message')
    const row = page.getByTestId('message').last()
    const dialog = await menu(page, row, 'me')
    await expect(dialog).toContainText('your own linked devices when they connect')
    await expect(dialog).toContainText('Other people keep their copies')
    await expect(dialog).toContainText('exports, old backups, and older clients')
    await expect(dialog).not.toContainText('only from this device')
    await dialog.getByRole('button', { name: 'Delete for me', exact: true }).click()
    await expect(page.getByTestId('message')).toHaveCount(0)
  })
}

test('legacy own Me confirmation explicitly falls back to this device', async ({ page }) => {
  await open(page)
  await action(page, 'ownDeletionMessage', { legacy: true })
  const dialog = await menu(page, page.getByTestId('message').last(), 'me')
  await expect(dialog).toContainText('only from this device')
  await expect(dialog).toContainText('Verification data is unavailable')
  await expect(dialog).not.toContainText('your own linked devices when they connect')
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Delete for me', exact: true }).click()
  await expect(page.getByTestId('message')).toHaveCount(0)
})

test('accepted everyone failure redacts content, preserves newer draft, and retries after expiry', async ({ page }) => {
  await open(page)
  await action(page, 'ownDeletionMessage', { media: true })
  const row = page.getByTestId('message').last()
  await row.focus(); await row.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Reply', exact: true }).click()
  await page.getByLabel('Message', { exact: true }).fill('Keep this text')
  await action(page, 'failDeletion', 1)
  const dialog = await menu(page, row, 'everyone')
  await dialog.getByRole('button', { name: 'Delete for everyone', exact: true }).click()
  await expect(row).toContainText('Message deleted')
  await expect(row).not.toContainText('Own deletion target')
  await expect(row.getByTestId('attachment')).toHaveCount(0)
  await expect(page.getByLabel('Replying to message')).toHaveCount(0)
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this text')
  await expect(row.getByRole('button', { name: 'Retry deletion' })).toBeVisible()
  await page.clock.install()
  await page.clock.fastForward(3_600_001)
  await row.getByRole('button', { name: 'Retry deletion' }).click()
  await expect(row).toContainText('Requesting deletion on other devices')
  const hide = await menu(page, row, 'me')
  await expect(hide).toContainText('hides the deletion status and retry control')
  await hide.getByRole('button', { name: 'Delete for me', exact: true }).click()
  await expect(page.getByTestId('message')).toHaveCount(0)
})

for (const scope of ['me', 'everyone'] as const) {
  test(`${scope} acceptance scrubs surviving reply previews through stale history and failed refresh`, async ({ page }) => {
    await open(page)
    await action(page, 'ownDeletionMessage')
    const original = page.getByTestId('message').first()
    await original.focus(); await original.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Reply', exact: true }).click()
    await page.getByLabel('Message', { exact: true }).fill('Surviving reply body')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const reply = page.getByTestId('message').filter({ hasText: 'Surviving reply body' })
    // Negative control: the quote must be visible before local acceptance.
    await expect(reply.getByLabel('Quoted message')).toContainText('Own deletion target')
    await action(page, 'holdStaleHistory')
    const dialog = await menu(page, original, scope)
    await dialog.getByRole('button', { name: `Delete for ${scope}`, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    // The deletion-triggered refresh is held. Only immediate projection can redact this quote.
    await expect(reply.getByLabel('Quoted message')).toContainText('Original message unavailable')
    await expect(reply).not.toContainText('Own deletion target')
    await action(page, 'releaseMessages')
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    // The held response contains the original and the old preview. It must remain suppressed.
    await expect(reply.getByLabel('Quoted message')).toContainText('Original message unavailable')
    await expect(page.getByTestId('message')).toHaveCount(scope === 'me' ? 1 : 2)
    await action(page, 'failMessages', 1)
    await action(page, 'refreshHistory')
    await expect(page.getByRole('button', { name: 'Retry loading messages' })).toBeVisible()
    await expect(reply).toContainText('Surviving reply body')
    await expect(reply.getByLabel('Quoted message')).toContainText('Original message unavailable')
    await expect(reply).not.toContainText('Own deletion target')
  })
}

for (const scope of ['me', 'everyone'] as const) {
  for (const content of ['photo', 'location'] as const) {
    test(`${scope} invalidation immediately removes cached ${content} and quotes despite refresh failure`, async ({ page }) => {
      await open(page)
      await action(page, 'ownDeletionMessage', { [content]: true })
      const original = page.getByTestId('message').first()
      await original.focus(); await original.press('Shift+F10')
      await page.getByRole('menuitem', { name: 'Reply', exact: true }).click()
      await page.getByLabel('Message', { exact: true }).fill('Keep remote deletion reply')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const reply = page.getByTestId('message').filter({ hasText: 'Keep remote deletion reply' })
      await expect(reply.getByLabel('Quoted message')).toContainText('Own deletion target')
      if (content === 'photo') {
        await original.getByRole('button', { name: 'Show photo secret.jpg', exact: true }).click()
        await expect(original.getByRole('button', { name: 'Photo secret.jpg', exact: true })).toBeVisible()
        await page.evaluate(() => {
          const src = document.querySelector<HTMLImageElement>('[data-testid="attachment"] img')!.src
          const activity = { src, revoked: [] as string[] }
          const revoke = URL.revokeObjectURL.bind(URL)
          Object.assign(window, { remoteDeletionMedia: activity })
          URL.revokeObjectURL = (url: string) => { activity.revoked.push(url); revoke(url) }
        })
      } else {
        await original.getByRole('button', { name: 'Show map', exact: true }).click()
        await expect(original.getByTestId('map')).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('data-map-style-pending', 'true')
      }
      // Negative control: an ordinary failed refresh must not erase readable cached content.
      await action(page, 'failMessages', 1)
      await action(page, 'refreshHistory')
      await expect(page.getByRole('button', { name: 'Retry loading messages' })).toBeVisible()
      await expect(original).toContainText('Own deletion target')
      await expect(reply.getByLabel('Quoted message')).toContainText('Own deletion target')
      await action(page, 'failMessages', 0)
      await action(page, 'remoteDeletion', { scope, mode: content === 'photo' ? 'hold' : 'fail' })
      // No successful history read has occurred since invalidation.
      await expect(reply.getByLabel('Quoted message')).toContainText('Original message unavailable')
      await expect(page.getByTestId('attachment')).toHaveCount(0)
      await expect(page.getByTestId('location')).toHaveCount(0)
      await expect(page.getByTestId('map')).toHaveCount(0)
      await expect(page.getByTestId('message')).toHaveCount(scope === 'me' ? 1 : 2)
      if (content === 'photo') {
        await expect.poll(() => page.evaluate(() => {
          const state = (window as unknown as { remoteDeletionMedia: { src: string; revoked: string[] } }).remoteDeletionMedia
          return state.revoked.includes(state.src)
        })).toBe(true)
        await action(page, 'releaseMessages')
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        await expect(page.getByTestId('attachment')).toHaveCount(0)
        await action(page, 'failMessages', 1)
        await action(page, 'refreshHistory')
      } else {
        await action(page, 'failMap')
      }
      await expect(page.getByRole('button', { name: 'Retry loading messages' })).toBeVisible()
      await expect(reply).toContainText('Keep remote deletion reply')
      await expect(reply).not.toContainText('Own deletion target')
      await expect(page.getByTestId('map')).toHaveCount(0)
      await expect(page.getByTestId('attachment')).toHaveCount(0)
      await expect(page.getByTestId('fixture-error')).toHaveCount(0)
    })
  }
}

test('verified everyone capability does not depend on reply capability', async ({ page }) => {
  await open(page)
  await action(page, 'ownDeletionMessage', { noReply: true })
  const row = page.getByTestId('message').last()
  await row.focus(); await row.press('Shift+F10')
  await expect(page.getByRole('menuitem', { name: 'Reply', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Delete for everyone', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Delete for everyone', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete for everyone', exact: true }).click()
  await expect(row).toContainText('Message deleted')
  await expect(row).not.toContainText('Own deletion target')
})

test('storage rejection preserves content and exposes an actionable confirmation error', async ({ page }) => {
  await open(page)
  await action(page, 'ownDeletionMessage', { pending: true })
  await action(page, 'failDeletionAcceptance', 1)
  const row = page.getByTestId('message').last()
  const dialog = await menu(page, row, 'me')
  await expect(dialog).toContainText('still be delivered')
  await dialog.getByRole('button', { name: 'Delete for me', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('storage failed')
  await expect(row).toContainText('Own deletion target')
  await action(page, 'failDeletionAcceptance', 0)
  await dialog.getByRole('button', { name: 'Delete for me', exact: true }).click()
  await expect(row).toHaveCount(0)
})

test('an open menu and confirmation expire at the inclusive deadline plus 1ms', async ({ page }) => {
  await open(page)
  await page.clock.install({ time: new Date('2026-11-08T11:59:59Z') })
  const start = Date.parse('2026-11-08T12:00:00Z')
  await page.clock.pauseAt(start)
  await action(page, 'ownDeletionMessage', { deadline: start + 1000 })
  const row = page.getByTestId('message').last()
  await row.focus(); await row.press('Shift+F10')
  await page.clock.runFor(1000)
  await expect(page.getByRole('menuitem', { name: 'Delete for everyone', exact: true })).toBeVisible()
  await page.clock.runFor(1)
  await expect(page.getByRole('menuitem', { name: 'Delete for everyone', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // Appending fixture data does not mean its asynchronous history read has rendered.
  await action(page, 'holdMessages')
  await action(page, 'ownDeletionMessage', { deadline: start + 2000 })
  await expect.poll(() => page.evaluate(() => (window as unknown as { interactionFixture: { historyPending(): boolean } }).interactionFixture.historyPending())).toBe(true)
  await expect(page.getByTestId('message')).toHaveCount(1)
  // Negative control: until history arrives, last() still selects the expired row.
  await row.focus(); await row.press('Shift+F10')
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('menuitem', { name: 'Delete for everyone', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await action(page, 'releaseMessages')
  await expect(page.getByTestId('message')).toHaveCount(2)
  const secondRow = page.getByTestId('message').nth(1)
  const dialog = await menu(page, secondRow, 'everyone')
  await page.clock.runFor(999)
  await expect(dialog.getByRole('button', { name: 'Delete for everyone', exact: true })).toBeEnabled()
  await page.clock.runFor(1)
  await expect(dialog.getByRole('button', { name: 'Delete for everyone', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
})

for (const guard of ['blockRenamedDirect', 'requestChat']) {
  test(`own deletion stays available in ${guard}`, async ({ page }) => {
    await open(page)
    await action(page, 'ownDeletionMessage')
    await action(page, guard)
    const row = page.getByTestId('message').last()
    const dialog = await menu(page, row, 'everyone')
    await dialog.getByRole('button', { name: 'Delete for everyone', exact: true }).click()
    await expect(row).toContainText('Message deleted')
    await row.focus(); await row.press('Shift+F10')
    await expect(page.getByRole('menuitem', { name: 'Reply', exact: true })).toHaveCount(0)
  })
}

test('received deletion invalidates existing quote previews without removing the reply body', async ({ page }) => {
  await open(page)
  await action(page, 'incoming', 'Original private content')
  const original = page.getByTestId('message').first()
  await original.focus(); await original.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Reply', exact: true }).click()
  await page.getByLabel('Message', { exact: true }).fill('Keep this reply body')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('message')).toHaveCount(2)
  await action(page, 'deleteIncoming')
  await expect(original).toContainText('Message deleted')
  await expect(page.getByLabel('Quoted message')).toContainText('Original message unavailable')
  await expect(page.getByTestId('message').last()).toContainText('Keep this reply body')
  await expect(page.getByTestId('message').last()).not.toContainText('Original private content')
})

test('deleting an own live card explains and reflects the matching producer stop', async ({ page }) => {
  await open(page)
  await action(page, 'activeLiveShare')
  const row = page.getByTestId('message').last()
  const dialog = await menu(page, row, 'me')
  await expect(dialog).toContainText('stops matching live location sharing on this device')
  await dialog.getByRole('button', { name: 'Delete for me', exact: true }).click()
  await expect(page.getByTestId('message')).toHaveCount(0)
  const stops = await page.evaluate(() => (window as unknown as { interactionFixture: { liveActivity: { stops: string[] } } }).interactionFixture.liveActivity.stops)
  expect(stops).toEqual(['chat'])
})

test('deleted playback stops and releases its object URL', async ({ page }) => {
  await open(page)
  await action(page, 'ownDeletionMessage', { video: true })
  const row = page.getByTestId('message').last()
  await row.getByRole('button', { name: 'Play secret.webm', exact: true }).click()
  await expect(row.locator('video')).toHaveCount(1)
  await page.evaluate(() => {
    const video = document.querySelector('video')!
    const revoked: string[] = []
    const revoke = URL.revokeObjectURL.bind(URL)
    const activity = { paused: false, src: video.src, revoked }
    Object.assign(window, { deletionMediaActivity: activity })
    video.pause = () => { activity.paused = true }
    URL.revokeObjectURL = (url: string) => { revoked.push(url); revoke(url) }
  })
  const dialog = await menu(page, row, 'everyone')
  await dialog.getByRole('button', { name: 'Delete for everyone', exact: true }).click()
  await expect(row.locator('video')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => {
    const state = (window as unknown as { deletionMediaActivity: { paused: boolean; src: string; revoked: string[] } }).deletionMediaActivity
    return state.paused && state.revoked.includes(state.src)
  })).toBe(true)
})

test('late attachment completion cannot download a deleted file', async ({ page }) => {
  await open(page)
  await action(page, 'ownDeletionMessage', { media: true })
  await action(page, 'holdAttachment')
  const row = page.getByTestId('message').last()
  await row.getByRole('button', { name: 'Download', exact: true }).click()
  const downloads: string[] = []
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  const dialog = await menu(page, row, 'everyone')
  await dialog.getByRole('button', { name: 'Delete for everyone', exact: true }).click()
  await expect(row.getByTestId('attachment')).toHaveCount(0)
  await action(page, 'releaseAttachment')
  await expect(row).toContainText('Message deleted')
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(downloads).toEqual([])
})

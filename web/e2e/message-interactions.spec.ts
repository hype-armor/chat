import { expect, test } from './fixtures'
import { fixtureAction, fixtureDraft, fixturePending, fixtureSend, openFixture, replyToMessage } from './interaction-fixture-support'
import { messages } from './support'
import { TYPING_TTL_MS } from '../src/core/typing'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; this suite requires the in-memory UI fixture')

// UI contracts only. The fixture substitutes an in-memory core and a local
// BroadcastChannel. These tests do not prove encrypted transport or persistence.
test('exact per-chat text survives switches and a UI restart against retained fake worker records', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'addChat')
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  const first = '  First draft\nwith whitespace  '
  await input.fill(first)
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe(first)
  await page.getByRole('button', { name: /Other chat/ }).click()
  await input.fill('Other draft')
  await expect.poll(async () => (await fixtureDraft(page, 'other')).text).toBe('Other draft')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(input).toHaveValue(first)
  await fixtureAction(page, 'restartUI')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(input).toHaveValue(first)
  await expect(page.getByText(/Saved|Saving/, { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /Other chat/ }).click()
  await expect(input).toHaveValue('Other draft')
})

test('a late draft load cannot overwrite typing', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'seedDraft', 'Old saved draft')
  await fixtureAction(page, 'holdDraftLoad')
  await fixtureAction(page, 'restartUI')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect.poll(() => fixturePending(page, 'load')).toBe(true)
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Typed before load completed')
  await fixtureAction(page, 'releaseDraftLoad')
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe('Typed before load completed')
  await expect(input).toHaveValue('Typed before load completed')
})

test('load and save errors preserve editable text and expose only failure retry actions', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'failDraftLoad', 1)
  await fixtureAction(page, 'restartUI')
  await page.getByRole('button', { name: /Bob/ }).click()
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await expect(page.getByRole('alert')).toContainText('Fixture draft load failed')
  await input.fill('Typed while loading failed')
  await fixtureAction(page, 'failDraftLoad', 0)
  await page.getByRole('button', { name: 'Retry draft', exact: true }).click()
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe('Typed while loading failed')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await fixtureAction(page, 'failDraftSave', 1)
  await input.fill('Save failure text')
  await expect(page.getByRole('alert')).toContainText('Fixture draft save failed')
  await input.fill('Newest text after failure')
  await fixtureAction(page, 'failDraftSave', 0)
  await page.getByRole('button', { name: 'Retry draft', exact: true }).click()
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe('Newest text after failure')
  await expect(input).toHaveValue('Newest text after failure')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a save conflict never substitutes stored text for local typing', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'conflictDraftSave')
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Keep my local text')
  await expect(page.getByRole('alert')).toContainText('saved draft changed')
  await expect(input).toHaveValue('Keep my local text')
  expect((await fixtureDraft(page)).text).toBe('Other saved text')
  await page.getByRole('button', { name: 'Retry draft', exact: true }).click()
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe('Keep my local text')
  await expect(input).toHaveValue('Keep my local text')
})

test('an unrelated empty save during a pending send still requires explicit conflict retry', async ({ page }) => {
  await openFixture(page)
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Pending submitted text')
  await fixtureAction(page, 'holdNextSend')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => fixturePending(page, 'send')).toBe(true)
  // Model another writer, not this send's conditional consumption fence.
  await fixtureAction(page, 'seedDraft', '')
  await input.fill('Keep this local edit')
  await fixtureAction(page, 'acceptSend')
  await expect(page.getByRole('alert')).toContainText('saved draft changed')
  await expect(input).toHaveValue('Keep this local edit')
  expect((await fixtureDraft(page)).text).toBe('')
  await page.getByRole('button', { name: 'Retry draft', exact: true }).click()
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe('Keep this local edit')
})

test('a delayed save queue survives conversation remounts without replacing newer edits', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'addChat')
  await fixtureAction(page, 'holdDraftSave')
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Pending first save')
  await expect.poll(() => fixturePending(page, 'save')).toBe(true)
  await page.getByRole('button', { name: /Other chat/ }).click()
  await input.fill('Independent other chat')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(input).toHaveValue('Pending first save')
  await input.fill('Newer queued text')
  await fixtureAction(page, 'releaseDraftSave')
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe('Newer queued text')
  await expect.poll(async () => (await fixtureDraft(page, 'other')).text).toBe('Independent other chat')
  await expect(input).toHaveValue('Newer queued text')
})

test('a late accepted send cannot clear identical new text after a conversation switch', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'addChat')
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Identical text')
  await fixtureAction(page, 'holdNextSend')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => fixturePending(page, 'send')).toBe(true)
  await page.getByRole('button', { name: /Other chat/ }).click()
  await input.fill('Other chat stays separate')
  await page.getByRole('button', { name: /Bob/ }).click()
  const submittedRevision = (await fixtureDraft(page)).revision
  await input.fill('Identical text')
  await expect.poll(async () => (await fixtureDraft(page)).revision).toBeGreaterThan(submittedRevision)
  await fixtureAction(page, 'acceptSend')
  await expect(messages(page).last()).toContainText('Identical text')
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe('Identical text')
  await expect(input).toHaveValue('Identical text')
  await fixtureAction(page, 'restartUI')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(input).toHaveValue('Identical text')
})

test('a rejected pending send restores its text while its conversation is unmounted', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'addChat')
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Rejected original')
  await fixtureAction(page, 'holdNextSend')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => fixturePending(page, 'send')).toBe(true)
  await page.getByRole('button', { name: /Other chat/ }).click()
  await input.fill('Other draft')
  await fixtureAction(page, 'rejectSend')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(input).toHaveValue('Rejected original')
  await expect(page.getByRole('alert')).toContainText('Fixture send failed')
  expect((await fixtureDraft(page)).text).toBe('Rejected original')
})

test('accepted text does not return after a UI restart against retained fake worker records', async ({ page }) => {
  await openFixture(page)
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('  Accepted text  ')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(messages(page).last()).toContainText('Accepted text')
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe('')
  await fixtureAction(page, 'restartUI')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(input).toHaveValue('')
})

for (const editDuringRestore of [false, true]) {
  test(`an immediate attachment waits for draft restore and preserves caption text (typing=${editDuringRestore})`, async ({ page }) => {
    await openFixture(page)
    await fixtureAction(page, 'seedDraft', 'Stored caption not yet restored')
    await fixtureAction(page, 'holdDraftLoad')
    await fixtureAction(page, 'restartUI')
    await page.getByRole('button', { name: /Bob/ }).click()
    await expect.poll(() => fixturePending(page, 'load')).toBe(true)
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await expect(input).toHaveValue('')
    await fixtureAction(page, 'holdNextSend')
    await page.getByTestId('attach-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture bytes') })
    await expect(input).toBeEditable()
    expect(await fixturePending(page, 'send')).toBe(false)
    if (editDuringRestore) await input.fill('Typed caption before restore completed')
    const caption = editDuringRestore ? 'Typed caption before restore completed' : 'Stored caption not yet restored'
    await fixtureAction(page, 'releaseDraftLoad')
    await expect.poll(() => fixturePending(page, 'send')).toBe(true)
    await expect(input).toHaveValue(caption)
    expect((await fixtureDraft(page)).text).toBe(caption)
    await fixtureAction(page, 'acceptSend')
    await expect(messages(page).last()).toContainText(caption)
    await expect(input).toHaveValue('')
    await fixtureAction(page, 'restartUI')
    await page.getByRole('button', { name: /Bob/ }).click()
    await expect(input).toHaveValue('')
  })
}

test('delayed attachment acceptance consumes its caption but preserves identical newer typing', async ({ page }) => {
  await openFixture(page)
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('Caption text')
  await fixtureAction(page, 'holdNextSend')
  await page.getByTestId('attach-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture bytes') })
  await expect.poll(() => fixturePending(page, 'send')).toBe(true)
  const captionRevision = (await fixtureDraft(page)).revision
  await input.fill('Caption text')
  // The newer edit must reach the worker before attachment acceptance completes.
  await expect.poll(async () => (await fixtureDraft(page)).revision).toBeGreaterThan(captionRevision)
  await fixtureAction(page, 'restartUI')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(input).toHaveValue('Caption text')
  await fixtureAction(page, 'acceptSend')
  await expect(messages(page).last()).toContainText('Caption text')
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe('Caption text')
  await expect(input).toHaveValue('Caption text')
  await fixtureAction(page, 'restartUI')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(input).toHaveValue('Caption text')
})

test('an accepted attachment caption cannot return after a UI restart', async ({ page }) => {
  await openFixture(page)
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  await input.fill('  Consumed caption  ')
  await page.getByTestId('attach-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture bytes') })
  await expect(input).toHaveValue('')
  await expect.poll(async () => (await fixtureDraft(page)).text).toBe('')
  await fixtureAction(page, 'restartUI')
  await page.getByRole('button', { name: /Bob/ }).click()
  await expect(input).toHaveValue('')
})

for (const width of [390, 1280]) {
  test(`live sharing keeps its card, sidebar indicator, Stop, and watcher without a top banner (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    await page.addInitScript(() => {
      let watches = 0
      let clears = 0
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          watchPosition(success: PositionCallback) {
            document.documentElement.dataset.fixtureGeoWatches = String(++watches)
            success({ coords: { latitude: 48.8584, longitude: 2.2945, accuracy: 12 } } as GeolocationPosition)
            return watches
          },
          clearWatch() { document.documentElement.dataset.fixtureGeoClears = String(++clears) },
        },
      })
    })
    await openFixture(page)
    await fixtureAction(page, 'addChat')
    const layout = page.locator('.chat-layout')
    const expectNoGap = async () => {
      await expect(page.locator('.live-sharing-indicators, .live-banner')).toHaveCount(0)
      await expect(page.getByRole('status', { name: /Sharing live location/ })).toHaveCount(0)
      await expect.poll(async () => {
        const box = (await layout.boundingBox())!
        return { top: box.y, height: box.height }
      }).toEqual({ top: 0, height: 720 })
    }
    await expectNoGap()
    const menuTrigger = page.getByRole('button', { name: 'Conversation menu', exact: true })
    const menuStop = page.getByRole('menu', { name: 'Conversation menu', exact: true }).getByRole('menuitem', { name: 'Stop sharing location', exact: true })
    await menuTrigger.click()
    await expect(menuStop).toHaveCount(0)
    await page.keyboard.press('Escape')
    await fixtureAction(page, 'activeLiveShare')
    const card = messages(page).getByTestId('live-location')
    const dot = page.locator('.sidebar .live-dot')
    await expect(card).toContainText('Live location · until')
    await expect(card.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible()
    await menuTrigger.click()
    await expect(menuStop).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dot).toHaveCount(1)
    // The mobile conversation hides the sidebar from the accessibility tree.
    await expect(page.getByRole('img', { name: 'Sharing live location', exact: true, includeHidden: true })).toHaveCount(1)
    await expect(page.getByRole('img', { name: 'Sharing live location', exact: true })).toHaveCount(width === 390 ? 0 : 1)
    await expect(dot).toHaveAttribute('aria-label', 'Sharing live location')
    await expect(page.locator('html')).toHaveAttribute('data-fixture-geo-watches', '1')
    await expect.poll(() => page.evaluate(() => (window as unknown as { interactionFixture: { liveActivity: { updates: number } } }).interactionFixture.liveActivity.updates)).toBe(1)
    await expectNoGap()

    if (width === 390) await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
    await page.getByRole('button', { name: /Other chat/ }).click()
    await expect(messages(page).getByTestId('live-location')).toHaveCount(0)
    await expect(dot).toHaveCount(1)
    await expectNoGap()
    if (width === 390) await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
    await page.getByRole('button', { name: /Bob/ }).click()
    await expect(card.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-fixture-geo-watches', '1')
    await card.getByRole('button', { name: 'Stop sharing', exact: true }).click()
    await expect(card).toHaveText('📍 Live location ended')
    await expect(dot).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('data-fixture-geo-clears', '1')
    await expect.poll(() => page.evaluate(() => (window as unknown as { interactionFixture: { liveActivity: { stops: string[] } } }).interactionFixture.liveActivity.stops)).toEqual(['chat'])
    await menuTrigger.click()
    await expect(menuStop).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expectNoGap()

    // An expired until-stopped lease remains active even while its card looks ended.
    await fixtureAction(page, 'activeLiveShare', 1)
    const expired = messages(page).getByTestId('live-location').last()
    await expect(expired).toHaveText('📍 Live location ended')
    await expect(expired.getByRole('button', { name: 'Stop sharing', exact: true })).toHaveCount(0)
    await expect(dot).toHaveCount(1)
    await menuTrigger.click()
    await expect(menuStop).toBeVisible()
    await menuStop.click()
    await expect(dot).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => (window as unknown as { interactionFixture: { liveActivity: { stops: string[] } } }).interactionFixture.liveActivity.stops)).toEqual(['chat', 'chat'])
    await menuTrigger.click()
    await expect(menuStop).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expectNoGap()
  })
}

test('metadata cannot be highlighted while body text stays selectable and the composer stays editable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openFixture(page)
  await fixtureAction(page, 'incoming', 'Selectable body text remains available.')
  const message = messages(page).last()
  const timestamp = message.locator('time')
  const date = page.locator('.messages .day-separator')
  await expect(timestamp).toBeVisible()
  await expect(date).toHaveCount(1)
  await expect(date).toHaveCSS('user-select', 'none')
  await expect(message.locator('.meta')).toHaveCSS('user-select', 'none')
  await expect(timestamp).toHaveCSS('user-select', 'none')
  await expect(message.locator(':scope > .visually-hidden').first()).toHaveCSS('user-select', 'none')

  const dragAcross = async (bounds: { x: number; y: number; width: number; height: number }) => {
    const y = bounds.y + bounds.height / 2
    await page.mouse.move(bounds.x + 1, y)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width - 1, y, { steps: 12 })
    await page.mouse.up()
  }
  const timeBounds = await timestamp.boundingBox()
  expect(timeBounds).not.toBeNull()
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  // Use real pointer selection, not a programmatic Range that bypasses CSS.
  await dragAcross(timeBounds!)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')

  const body = message.locator('.text')
  const bodyBounds = await body.boundingBox()
  expect(bodyBounds).not.toBeNull()
  await dragAcross(bodyBounds!)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('body text')
  await expect(body).toHaveText('Selectable body text remains available.')
  await expect(page.getByRole('menu')).toHaveCount(0)

  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill('A draft')
  await composer.press('End')
  await page.keyboard.type(' remains editable')
  await expect(composer).toHaveValue('A draft remains editable')
  await expect(composer).toBeFocused()
})

test('message actions stay hidden until keyboard invocation and restore focus on Escape', async ({ page }) => {
  await openFixture(page)
  await fixtureSend(page, 'An own message with a reply action')
  const message = messages(page).last()
  await expect(message.getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Reply', exact: true })).toHaveCount(0)
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await expect(composer).toHaveCount(1)
  await composer.fill('A new draft')
  await message.focus()
  await message.press('ContextMenu')
  const reply = page.getByRole('menuitem', { name: 'Reply', exact: true })
  await expect(reply).toBeFocused()
  await reply.press('ArrowDown')
  await expect(reply).toBeFocused()
  await reply.press('Escape')
  await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0)
  await expect(message).toBeFocused()
  await expect(composer).toHaveValue('A new draft')
  await expect(page.getByRole('button', { name: 'Cancel reply', exact: true })).toHaveCount(0)
})

test('touch long press opens Reply and movement, scroll, release, and cancellation stop the gesture', async ({ page }) => {
  await openFixture(page)
  await fixtureSend(page, 'Touch action original')
  const message = messages(page).last()
  const menu = page.getByRole('menu', { name: 'Message actions', exact: true })
  await page.clock.install()
  const bounds = await message.boundingBox()
  expect(bounds).not.toBeNull()
  const pointer = { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: bounds!.x + 8, clientY: bounds!.y + 8 }
  for (const cancel of ['movement', 'scroll', 'pointercancel', 'pointerup']) {
    await message.dispatchEvent('pointerdown', pointer)
    if (cancel === 'movement') await message.dispatchEvent('pointermove', { ...pointer, clientX: pointer.clientX + 20 })
    else if (cancel === 'scroll') await page.locator('.messages-viewport').evaluate((element) => element.dispatchEvent(new Event('scroll')))
    else await message.dispatchEvent(cancel, pointer)
    // Advance the gesture clock, not an arbitrary browser settling delay.
    await page.clock.runFor(600)
    await message.dispatchEvent('contextmenu', { clientX: pointer.clientX, clientY: pointer.clientY })
    await expect(menu).toHaveCount(0)
  }
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click()
  await expect(page.getByRole('menu', { name: 'Conversation menu', exact: true })).toBeVisible()
  await message.dispatchEvent('pointerdown', pointer)
  await page.clock.runFor(600)
  await expect(page.getByRole('menu', { name: 'Conversation menu', exact: true })).toHaveCount(0)
  await expect(menu).toBeVisible()
  await message.dispatchEvent('pointerup', pointer)
  // Model mobile selection/contextmenu that arrives after the finger lifts.
  const delayed = await message.locator('.text').evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(delayed).toBe(true)
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Reply', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Replying to message', exact: true })).toContainText('Touch action original')
})

test('an owned touch press wins over browser text selection but preserves a pre-existing selection', async ({ page }) => {
  await openFixture(page)
  await fixtureSend(page, 'Native browser touch selection')
  const message = messages(page).last()
  const text = message.locator('.text')
  const menu = page.getByRole('menu', { name: 'Message actions', exact: true })
  await page.clock.install()
  const pointer = { pointerId: 15, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 100 }
  await text.dispatchEvent('pointerdown', pointer)
  // Mobile browsers can select plain text before they fire contextmenu.
  const owned = await text.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(owned).toBe(true)
  await expect(menu).toBeVisible()
  await text.dispatchEvent('pointerup', pointer)
  await menu.getByRole('menuitem', { name: 'Reply', exact: true }).press('Escape')
  await text.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await text.dispatchEvent('pointerdown', pointer)
  await page.clock.runFor(600)
  const existing = await text.evaluate((element) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    return { prevented: event.defaultPrevented, text: window.getSelection()?.toString() }
  })
  expect(existing.prevented).toBe(false)
  expect(existing.text).toBe('Native browser touch selection')
  await expect(menu).toHaveCount(0)
})

test('message actions stay separate from link actions and preserve existing native selection', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', 'Read https://example.invalid/native-selection')
  const message = messages(page).last()
  const menu = page.getByRole('menu', { name: 'Message actions', exact: true })
  const linkMenu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await message.locator('.meta').click({ button: 'right' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'Reply', exact: true }).press('Escape')
  const link = message.getByRole('link')
  await link.click({ button: 'right' })
  await expect(linkMenu).toBeVisible()
  await expect(menu).toHaveCount(0)
  await expect(linkMenu.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await page.clock.install()
  await link.dispatchEvent('pointerdown', { pointerId: 9, pointerType: 'touch', isPrimary: true, button: 0 })
  await page.clock.runFor(600)
  await expect(linkMenu).toBeVisible()
  await expect(menu).toHaveCount(0)
  await link.dispatchEvent('pointerup', { pointerId: 9, pointerType: 'touch', isPrimary: true, button: 0 })
  await page.keyboard.press('Escape')
  const selection = await message.locator('.text').evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    return { selected: selection.toString(), prevented: event.defaultPrevented }
  })
  expect(selection.selected).toContain('Read https://example.invalid/native-selection')
  expect(selection.prevented).toBe(false)
  await expect(menu).toHaveCount(0)
  await expect(linkMenu).toHaveCount(0)
})

test('conversation, link, and message menus replace one another without stealing gesture focus', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', 'Menu coexistence https://example.invalid/coexistence')
  const message = messages(page).last()
  const trigger = page.getByRole('button', { name: 'Conversation menu', exact: true })
  const conversation = page.getByRole('menu', { name: 'Conversation menu', exact: true })
  const reply = page.getByRole('menu', { name: 'Message actions', exact: true })
  const actions = page.getByRole('menu', { name: 'Link actions', exact: true })
  await page.clock.install()
  let pointerId = 30
  const longPress = async (onLink: boolean) => {
    const target = onLink ? message.getByRole('link') : message.locator('.meta')
    const pointer = { pointerId: pointerId++, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 100 }
    await target.dispatchEvent('pointerdown', pointer)
    await page.clock.runFor(600)
    await target.dispatchEvent('pointerup', pointer)
    await expect(conversation).toHaveCount(0)
    await expect(page.getByRole('menu')).toHaveCount(1)
    await expect(onLink ? actions : reply).toBeVisible()
    await expect((onLink ? actions : reply).getByRole('menuitem', { name: onLink ? 'Open' : 'Reply', exact: true })).toBeFocused()
  }
  await trigger.click()
  await expect(conversation).toBeVisible()
  await longPress(true)
  await trigger.click()
  await expect(conversation).toBeVisible()
  await expect(actions).toHaveCount(0)
  await longPress(false)
  await longPress(true)
  await longPress(false)
  await trigger.click()
  await expect(conversation).toBeVisible()
  await expect(reply).toHaveCount(0)
  await expect(actions).toHaveCount(0)
  await expect(page.getByRole('menu')).toHaveCount(1)
})

test('controls and media descendants retain native touch and context-menu handling', async ({ page }) => {
  await openFixture(page)
  await fixtureSend(page, 'Protected message children')
  const message = messages(page).last()
  // Model protected descendants without fetching media or invoking playback.
  await message.evaluate((element) => {
    for (const tag of ['button', 'input', 'textarea', 'video', 'audio', 'img']) {
      const child = document.createElement(tag)
      child.dataset.protectedChild = tag
      element.append(child)
    }
  })
  await page.clock.install()
  for (const tag of ['button', 'input', 'textarea', 'video', 'audio', 'img']) {
    const child = message.locator(`[data-protected-child="${tag}"]`)
    await child.dispatchEvent('pointerdown', { pointerId: 25, pointerType: 'touch', isPrimary: true, button: 0 })
    await page.clock.runFor(600)
    expect(await child.evaluate((element) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })).toBe(false)
    await child.dispatchEvent('pointerup', { pointerId: 25, pointerType: 'touch', isPrimary: true, button: 0 })
    await expect(page.getByRole('menu', { name: 'Message actions', exact: true })).toHaveCount(0)
  }
})

test('typing is a checked conversation-menu item with keyboard navigation and no inline checkbox', async ({ page }) => {
  await openFixture(page)
  await expect(page.getByRole('checkbox', { name: 'Typing indicators', exact: true })).toHaveCount(0)
  const trigger = page.getByRole('button', { name: 'Conversation menu', exact: true })
  await trigger.focus()
  await trigger.press('ArrowDown')
  const menu = page.getByRole('menu', { name: 'Conversation menu', exact: true })
  const toggle = menu.getByRole('menuitemcheckbox', { name: /Typing indicators/ })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toBeFocused()
  await toggle.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Verify safety number', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(toggle).toBeFocused()
  await toggle.press('Space')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.press('Enter')
  await trigger.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('checkbox', { name: 'Typing indicators', exact: true })).toHaveCount(0)
})

test('links expose isolated Open, Copy, and Share actions without fetching previews', async ({ page }) => {
  const url = 'https://example.invalid/reference?q=one&x=two#section'
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { document.documentElement.dataset.copied = text } },
    })
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: ShareData) => { document.documentElement.dataset.shared = data.url },
    })
  })
  const requests: string[] = []
  await page.context().route('https://example.invalid/**', async (route) => {
    requests.push(route.request().url())
    await route.fulfill({ contentType: 'text/html', body: '<title>Local destination fixture</title>' })
  })
  await openFixture(page)
  await fixtureAction(page, 'incoming', `Read ${url} and javascript:alert(1)`)
  const message = messages(page).last()
  const actions = page.getByRole('menu', { name: 'Link actions', exact: true })
  const link = message.getByRole('link', { name: url, exact: true })
  await expect(link).toHaveAttribute('href', url)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
  await expect(message.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(message).toContainText('javascript:alert(1)')
  expect(requests).toEqual([])
  await link.press('Shift+F10')
  await actions.getByRole('menuitem', { name: 'Copy link', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-copied', url)
  await actions.getByRole('menuitem', { name: 'Share', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-shared', url)
  const popupPromise = page.waitForEvent('popup')
  await actions.getByRole('menuitem', { name: 'Open', exact: true }).click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  expect(popup.url()).toBe(url)
  expect(await popup.evaluate(() => window.opener === null)).toBe(true)
  await popup.close()
})

test('a quoted reply can be cancelled without losing the draft and appears on the other client', async ({ context, page }) => {
  const bob = await context.newPage()
  const room = 'quoted-reply'
  await openFixture(page, 'Alice', room)
  await openFixture(bob, 'Bob', room)
  await fixtureSend(bob, 'Original message')
  const original = messages(page).filter({ hasText: 'Original message' }).last()
  await expect(original).toBeVisible()
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft')
  await replyToMessage(page, original)
  const preview = page.getByRole('complementary', { name: 'Replying to message', exact: true })
  await expect(preview).toContainText('Original message')
  await page.getByRole('button', { name: 'Cancel reply', exact: true }).click()
  await expect(preview).toHaveCount(0)
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft')
  await replyToMessage(page, original)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(preview).toHaveCount(0)
  const received = messages(bob).filter({ hasText: 'Keep this draft' }).last()
  await expect(received.getByRole('complementary', { name: 'Quoted message', exact: true })).toContainText('Original message')
  await bob.close()
})

for (const eligibility of ['false', 'undefined']) {
test(`messages with canReply=${eligibility} have no custom reply action and preserve the composer`, async ({ page }) => {
  await openFixture(page)
  await fixtureSend(page, 'Verified new original')
  await fixtureAction(page, 'legacyMessage', eligibility === 'undefined' ? 1 : 0)
  const original = messages(page).filter({ hasText: 'Verified new original' }).first()
  const legacy = messages(page).filter({ hasText: 'Legacy message without verification data' }).first()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  const preview = page.getByRole('complementary', { name: 'Replying to message', exact: true })
  const menu = page.getByRole('menu', { name: 'Message actions', exact: true })
  await composer.fill('Preserve this draft')
  await legacy.click({ button: 'right' })
  await expect(menu).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(composer).toHaveValue('Preserve this draft')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(legacy).not.toHaveAttribute('aria-haspopup', 'menu')
  await page.clock.install()
  await legacy.dispatchEvent('pointerdown', { pointerId: 21, pointerType: 'touch', isPrimary: true, button: 0 })
  await page.clock.runFor(600)
  await expect(menu).toHaveCount(0)
  await legacy.dispatchEvent('pointerup', { pointerId: 21, pointerType: 'touch', isPrimary: true, button: 0 })
  expect(await legacy.evaluate((element) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })).toBe(false)

  await replyToMessage(page, original)
  await expect(preview).toContainText('Verified new original')
  await legacy.click({ button: 'right' })
  await expect(menu).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(composer).toHaveValue('Preserve this draft')
  await expect(preview).toContainText('Verified new original')
  await expect(preview).not.toContainText('Legacy message without verification data')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(preview).toHaveCount(0)
  await expect(messages(page).last().getByRole('complementary', { name: 'Quoted message', exact: true })).toContainText('Verified new original')
})

}

test('reply eligibility refreshes through the normal messages event', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'legacyMessage')
  const original = messages(page).first()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill('Keep the pending draft')
  await expect(original).not.toHaveAttribute('aria-haspopup', 'menu')
  await fixtureAction(page, 'makeReplyAvailable')
  await expect(original).toHaveAttribute('aria-haspopup', 'menu')
  await replyToMessage(page, original)
  await expect(page.getByRole('complementary', { name: 'Replying to message', exact: true })).toContainText('Legacy message without verification data')
  await expect(composer).toHaveValue('Keep the pending draft')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a reply with no local original remains readable', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'missingReply')
  const reply = messages(page).last()
  await expect(reply).toContainText('Reply without local original')
  await expect(reply).toContainText('Original message unavailable')
  await expect(page.getByTestId('fixture-error')).toHaveCount(0)
})

test('typing reaches another client, expires without a stop, and clears after send', async ({ context, page }) => {
  test.setTimeout(30_000)
  const bob = await context.newPage()
  // Install before application timers. Only this fixture's window timers are
  // modeled here; production worker lease clocks have separate unit coverage.
  const start = new Date('2026-01-01T00:00:00Z')
  await page.clock.install({ time: start })
  await bob.clock.install({ time: start })
  await openFixture(page, 'Alice', 'typing')
  await openFixture(bob, 'Bob', 'typing')
  // Finish normal setup before freezing. The minute boundary exceeds the
  // setup budget and gives both pages a deterministic starting timestamp.
  const paused = new Date(start.getTime() + 60_000)
  await page.clock.pauseAt(paused)
  await bob.clock.pauseAt(paused)
  await fixtureAction(bob, 'dropTypingStops', 1)
  const input = page.getByLabel('Message', { exact: true })
  const typing = bob.getByRole('status').filter({ hasText: 'Alice is typing' })
  await input.fill('A pending draft')
  await expect(typing).toBeVisible()
  // Retain the draft and discard stop events. Check both sides of the lease
  // boundary without spending 8 seconds of the test budget on a window timer.
  await bob.clock.runFor(TYPING_TTL_MS - 1)
  await expect(typing).toBeVisible()
  await expect(input).toHaveValue('A pending draft')
  // The fixture sweeps every 100ms. Give the next sweep time to publish expiry.
  await bob.clock.runFor(101)
  await expect(typing).toHaveCount(0)
  await fixtureAction(bob, 'dropTypingStops', 0)
  // Advance past the sender's 2s refresh throttle, but not its 4s idle stop.
  // Receiver-only clock advancement must not prevent a fresh edited start.
  await page.clock.runFor(2_000)
  await input.fill('A changed draft')
  await expect(typing).toBeVisible()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(messages(bob).last()).toContainText('A changed draft')
  await expect(typing).toHaveCount(0)
  await bob.close()
})


test('long URLs fit a narrow screen and clipboard errors remain actionable without Share', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied by fixture') } },
    })
  })
  await openFixture(page)
  const url = 'https://example.invalid/' + 'a'.repeat(600)
  await fixtureAction(page, 'incoming', url)
  const message = messages(page).last()
  const actions = page.getByRole('menu', { name: 'Link actions', exact: true })
  await expect(message.getByRole('link', { name: url, exact: true })).toBeVisible()
  await expect.poll(() => page.locator('.messages-viewport').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  await expect.poll(() => page.locator('html').evaluate((el) => el.scrollWidth)).toBe(390)
  await message.getByRole('link', { name: url, exact: true }).press('Shift+F10')
  await expect(actions.getByRole('menuitem', { name: 'Share', exact: true })).toHaveCount(0)
  await actions.getByRole('menuitem', { name: 'Copy link', exact: true }).click()
  await expect(actions.getByRole('alert')).toContainText('Clipboard denied by fixture')
  await expect(actions.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible()
})

test('cancelling a native Share action does not show an error', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true, value: async () => { throw new DOMException('Cancelled', 'AbortError') },
    })
  })
  await openFixture(page)
  await fixtureAction(page, 'incoming', 'https://example.invalid/cancel')
  const message = messages(page).last()
  const actions = page.getByRole('menu', { name: 'Link actions', exact: true })
  await message.getByRole('link', { name: 'https://example.invalid/cancel', exact: true }).press('Shift+F10')
  await actions.getByRole('menuitem', { name: 'Share', exact: true }).click()
  await expect(actions.getByRole('alert')).toHaveCount(0)
})

test('a failed send restores its draft and quote but never overwrites a newer pair', async ({ page }) => {
  await openFixture(page)
  await fixtureAction(page, 'incoming', 'First original')
  const first = messages(page).filter({ hasText: 'First original' })
  await replyToMessage(page, first)
  await page.getByLabel('Message', { exact: true }).fill('First reply draft')
  await fixtureAction(page, 'holdNextSend')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
  await fixtureAction(page, 'rejectSend')
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('First reply draft')
  const preview = page.getByRole('complementary', { name: 'Replying to message', exact: true })
  await expect(preview).toContainText('First original')
  await fixtureAction(page, 'holdNextSend')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('')
  await fixtureAction(page, 'incoming', 'Second original')
  await replyToMessage(page, messages(page).filter({ hasText: 'Second original' }))
  await page.getByLabel('Message', { exact: true }).fill('Newer reply draft')
  await fixtureAction(page, 'rejectSend')
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Newer reply draft')
  await expect(preview).toContainText('Second original')
  await expect(preview).not.toContainText('First original')
  await expect(page.getByText('First reply draft', { exact: true })).toBeVisible()
})


test('continuous edits renew typing but blur and hidden state stop it', async ({ context, page }) => {
  const bob = await context.newPage()
  await openFixture(page, 'Alice', 'typing-renewal')
  await openFixture(bob, 'Bob', 'typing-renewal')
  await page.clock.install()
  await bob.clock.install()
  const input = page.getByLabel('Message', { exact: true })
  const typing = bob.getByRole('status').filter({ hasText: 'Alice is typing' })
  await input.fill('Edit 0')
  await expect(typing).toBeVisible()
  // More than one 8-second lease elapses, but continued edits renew it.
  for (let i = 1; i <= 4; i++) {
    await page.clock.fastForward(2500)
    await bob.clock.fastForward(2500)
    await input.fill('Edit ' + i)
    await expect(typing).toBeVisible()
  }
  await input.press('Tab')
  await expect(typing).toHaveCount(0)
  await input.fill('Fresh edit after focus')
  await expect(typing).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(typing).toHaveCount(0)
  await bob.close()
})

for (const [label, durationMs] of [['15 min', 15 * 60_000], ['Until stopped', null]] as const) {
  test('a delayed map failure cannot move the ' + label + ' button during a live-location click', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(() => {
      // The real ShareLocation component reads a position, without OS services.
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: (success: PositionCallback) => success({
            coords: { latitude: 48.8584, longitude: 2.2945, accuracy: 12 },
            timestamp: Date.now(),
          } as GeolocationPosition),
        },
      })
    })
    await openFixture(page)
    await page.getByRole('button', { name: 'Add attachment', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Location', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Share this location?', exact: true })
    await expect(dialog).toContainText('48.85840, 2.29450 · ±12 m')
    await expect(page.locator('html')).toHaveAttribute('data-map-style-pending', 'true')
    const button = dialog.getByRole('button', { name: label, exact: true })
    await expect(button).toBeVisible()
    await button.evaluate((el) => {
      el.addEventListener('mousedown', () => {
        (window as unknown as { interactionFixture: { failMap(): void } }).interactionFixture.failMap()
      }, { once: true })
    })
    const before = (await button.boundingBox())!
    const calls = () => page.evaluate(() => (window as unknown as {
      interactionFixture: { liveStarts: { conversationId: string; durationMs: number | null; location: { latitude: number; longitude: number; accuracyM: number } }[] }
    }).interactionFixture.liveStarts)
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    let after: typeof before
    try {
      // Force the real asynchronous MapView error render between down and up.
      await expect(dialog.getByText("The map can't be shown in this browser.", { exact: true })).toBeVisible()
      after = (await button.boundingBox())!
      expect(await calls()).toEqual([])
    } finally {
      // Do not move to the new location. A user releases at the original point.
      await page.mouse.up()
    }
    // Verify the action as well as geometry, so a lost click cannot be hidden.
    await expect(dialog).toBeHidden()
    expect(await calls()).toEqual([{
      conversationId: 'chat', durationMs,
      location: { latitude: 48.8584, longitude: 2.2945, accuracyM: 12 },
    }])
    expect(after).toEqual(before)
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused()
  })
}

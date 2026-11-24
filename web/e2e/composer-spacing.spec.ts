import { type Locator, expect, test } from './fixtures'
import { fixtureAction, openFixture } from './interaction-fixture-support'

test.skip(!process.env.E2E_UI_FIXTURES, 'use playwright.fixtures.config.ts; this suite requires the in-memory UI fixture')

async function expectCompact(composer: Locator) {
  const row = composer.locator('.composer-row')
  await expect(composer).toHaveCSS('row-gap', '0px')
  await expect(composer.locator('.typing-controls')).toBeHidden()
  await expect(row).toHaveCSS('padding-top', '8px')
  await expect(row).toHaveCSS('padding-bottom', '8px')
  await expect.poll(() => composer.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const row = element.querySelector('.composer-row')!.getBoundingClientRect()
    const style = getComputedStyle(element)
    const topBorder = parseFloat(style.borderTopWidth)
    const bottomBorder = parseFloat(style.borderBottomWidth)
    // The form's 1px border is not an empty row or a grid gap.
    const round = (value: number) => Math.round(value * 1000) / 1000
    return {
      extraContentHeight: round(box.height - topBorder - bottomBorder - row.height),
      spaceAboveRow: round(row.top - box.top - topBorder),
      spaceBelowRow: round(box.bottom - row.bottom - bottomBorder),
    }
  })).toEqual({ extraContentHeight: 0, spaceAboveRow: 0, spaceBelowRow: 0 })
}

test('draft edits do not render the message history again', async ({ page }) => {
  await openFixture(page, 'Alice', 'composer-history-render')
  await fixtureAction(page, 'seed', 100)
  await expect(page.getByTestId('message')).toHaveCount(100)
  const input = page.getByRole('textbox', { name: 'Message', exact: true })
  // Message rows format their timestamps during render. Count those calls only
  // after the seeded history is visible, and restore the browser API afterward.
  await page.evaluate(() => {
    const original = Date.prototype.toLocaleString
    Object.assign(window, { __historyDateCalls: 0, __restoreHistoryDates: () => { Date.prototype.toLocaleString = original } })
    Date.prototype.toLocaleString = function (...args) {
      ;(window as unknown as { __historyDateCalls: number }).__historyDateCalls++
      return Reflect.apply(original, this, args)
    }
  })
  try {
    await input.pressSequentially('Several edits')
    await expect(input).toHaveValue('Several edits')
    expect(await page.evaluate(() => (window as unknown as { __historyDateCalls: number }).__historyDateCalls)).toBe(0)
    // A new message must still update the history and its rendered content.
    await fixtureAction(page, 'incoming', 'New message after typing')
    await expect(page.getByTestId('message')).toHaveCount(101)
    await expect(page.getByTestId('message').last()).toContainText('New message after typing')
    expect(await page.evaluate(() => (window as unknown as { __historyDateCalls: number }).__historyDateCalls)).toBeGreaterThan(0)
  } finally {
    await page.evaluate(() => (window as unknown as { __restoreHistoryDates: () => void }).__restoreHistoryDates())
  }
})

// CSS and event-ordering coverage only. The synthetic visual viewport does not
// emulate a real mobile keyboard, browser chrome, or physical safe-area insets.
for (const width of [390, 1280]) {
  test(`the composer ends at the bottom of the layout (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await openFixture(page, 'Alice', `composer-spacing-bottom-${width}`)
    const layout = page.locator('.chat-layout')
    const composer = page.locator('.composer')
    // A reserved home-indicator strip would show as dead space below the box.
    await expect(layout).toHaveCSS('padding-bottom', '0px')
    await expect.poll(async () => {
      const area = (await layout.boundingBox())!
      const form = (await composer.boundingBox())!
      return Math.round(area.y + area.height - form.y - form.height)
    }).toBe(0)
  })

  test(`the composer stays flush with the bottom when the keyboard resizes the layout viewport (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.addInitScript(() => {
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: Object.assign(new EventTarget(), { width: window.innerWidth, height: 844, offsetTop: 0, scale: 1 }),
      })
    })
    await openFixture(page, 'Alice', `composer-spacing-resizes-content-${width}`)
    // `interactive-widget=resizes-content` shortens the layout viewport and the
    // visual viewport together as the keyboard opens.
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 500, offsetTop: 0 })
      window.visualViewport!.dispatchEvent(new Event('resize'))
    })
    await expect(page.locator('.chat-layout')).toHaveCSS('padding-bottom', '0px')
    await expect.poll(async () => {
      const area = (await page.locator('.chat-layout').boundingBox())!
      const form = (await page.locator('.composer').boundingBox())!
      return { height: area.height, gap: Math.round(area.y + area.height - form.y - form.height) }
    }).toEqual({ height: 500, gap: 0 })
  })

  test(`the idle composer stays compact across edits and visual viewport changes (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.addInitScript((width) => {
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: Object.assign(new EventTarget(), { width, height: 844, offsetTop: 0, scale: 1 }),
      })
    }, width)
    await openFixture(page, 'Alice', `composer-spacing-idle-${width}`)
    const composer = page.locator('.composer')
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    const viewport = async (height: number, offsetTop: number) => {
      await page.evaluate(({ height, offsetTop }) => {
        Object.assign(window.visualViewport!, { height, offsetTop })
        window.visualViewport!.dispatchEvent(new Event('resize'))
        window.visualViewport!.dispatchEvent(new Event('scroll'))
      }, { height, offsetTop })
      await expect.poll(async () => {
        const layout = (await page.locator('.chat-layout').boundingBox())!
        const form = (await composer.boundingBox())!
        return { top: layout.y, height: layout.height, composerBottom: form.y + form.height }
      }).toEqual({ top: offsetTop, height, composerBottom: offsetTop + height })
      await expect(input).toBeInViewport({ ratio: 1 })
    }

    await expectCompact(composer)
    console.log('[composer-spacing] idle geometry', JSON.stringify({
      browser: test.info().project.name,
      width,
      composerHeight: (await composer.boundingBox())!.height,
      rowHeight: (await composer.locator('.composer-row').boundingBox())!.height,
    }))
    await input.fill('A draft')
    await expectCompact(composer)
    await input.fill('')
    await expectCompact(composer)
    await input.focus()
    await viewport(500, 344)
    await expect(page.locator('.chat-layout')).toHaveCSS('padding-bottom', '0px')
    await expectCompact(composer)
    await input.fill('Draft')
    await expectCompact(composer)
    await input.fill('')
    await expectCompact(composer)
    await viewport(500, 300)
    await expectCompact(composer)
    await viewport(844, 0)
    await expectCompact(composer)
    await expect(page.locator('.chat-layout')).toHaveCSS('padding-bottom', '0px')
  })

  test(`active remote typing remains visible and collapses when it stops (${width}px)`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 844 })
    const bob = await context.newPage()
    const room = `composer-spacing-typing-${width}`
    await Promise.all([openFixture(page, 'Alice', room), openFixture(bob, 'Bob', room)])
    const composer = page.locator('.composer')
    const typing = composer.locator('.typing-controls')
    await expectCompact(composer)
    const bobInput = bob.getByRole('textbox', { name: 'Message', exact: true })
    await bobInput.fill('A remote draft')
    await expect(typing).toBeVisible()
    await expect(typing.getByRole('status')).toHaveText('Bob is typing…')
    await expect(typing).toHaveCSS('min-height', '32px')
    await expect(composer).toHaveCSS('row-gap', '0px')
    await expect.poll(() => composer.evaluate((element) => {
      const form = element.getBoundingClientRect()
      const typing = element.querySelector('.typing-controls')!.getBoundingClientRect()
      const row = element.querySelector('.composer-row')!.getBoundingClientRect()
      const style = getComputedStyle(element)
      const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
      return {
        typingHasRoom: typing.height >= 32,
        interRowGap: Math.round((row.top - typing.bottom) * 1000) / 1000,
        extraContentHeight: Math.round((form.height - borders - row.height - typing.height) * 1000) / 1000,
      }
    })).toEqual({ typingHasRoom: true, interRowGap: 0, extraContentHeight: 0 })
    await bobInput.fill('')
    await expectCompact(composer)
    await bob.close()
  })
}

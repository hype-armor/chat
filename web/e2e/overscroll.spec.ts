import { expect, test } from '@playwright/test'
import { closeDetails, compose, conversationAction, messages, openSettings, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

for (const width of [1280, 390]) {
  test(`list overscroll stays inside the app (${width}px)`, async ({ browser }) => {
    test.setTimeout(90_000)
    const username = randomUsername()
    const alice = await signUp(browser, 'Alice', randomUsername())
    const bob = await signUp(browser, 'Bob', username)
    await alice.setViewportSize({ width, height: 720 })

    for (const selector of ['html', 'body']) {
      await expect(alice.locator(selector)).toHaveCSS('overscroll-behavior-y', 'none')
    }
    for (const selector of ['.conversation-nav', '.conversations']) {
      await expect(alice.locator(selector)).toHaveCSS('overscroll-behavior-y', 'contain')
    }
    if (width > 640) {
      await expect(alice.locator('.placeholder')).toHaveCSS('overscroll-behavior-y', 'contain')
    }

    await compose(alice, 'New group')
    await expect(alice.locator('.compose-panel')).toHaveCSS('overscroll-behavior-y', 'contain')
    await expect(alice.getByLabel("Members' usernames")).toHaveCSS('overscroll-behavior-y', 'contain')
    await alice.getByRole('button', { name: '← Back', exact: true }).click()
    await startChat(alice, username)
    const viewport = alice.locator('.messages-viewport')
    await expect(viewport).toHaveCSS('overscroll-behavior-y', 'contain')
    await expect(alice.getByLabel('Message', { exact: true })).toHaveCSS('overscroll-behavior-y', 'contain')
    for (let i = 0; i < 24; i++) {
      await alice.getByLabel('Message', { exact: true }).fill(`Overscroll history ${i}`)
      await alice.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(messages(alice).last()).toContainText(`Overscroll history ${i}`)
      await expect(messages(alice).last().getByRole('img', { name: /^(Sent|Delivered|Read)$/ })).toBeVisible()
    }
    await expect.poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(300)

    const header = await alice.locator('.conversation-bar').boundingBox()
    const composer = await alice.locator('.composer').boundingBox()
    for (const end of ['bottom', 'top']) {
      await viewport.evaluate((el, end) => { el.scrollTop = end === 'bottom' ? el.scrollHeight : 0 }, end)
      await expect.poll(() => viewport.evaluate((el, end) =>
        end === 'bottom' ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop, end,
      )).toBeLessThanOrEqual(1)
      await viewport.hover()
      await alice.mouse.wheel(0, end === 'bottom' ? 2000 : -2000)
      await alice.evaluate('new Promise(requestAnimationFrame)')
      await alice.evaluate('new Promise(requestAnimationFrame)')
      expect(await alice.evaluate(`({
        documentTop: document.scrollingElement.scrollTop,
        documentLeft: document.scrollingElement.scrollLeft,
        viewportTop: window.visualViewport.offsetTop,
        viewportLeft: window.visualViewport.offsetLeft,
        pageTop: window.visualViewport.pageTop,
        pageLeft: window.visualViewport.pageLeft,
      })`)).toEqual({
        documentTop: 0, documentLeft: 0, viewportTop: 0, viewportLeft: 0, pageTop: 0, pageLeft: 0,
      })
      expect(await alice.locator('.conversation-bar').boundingBox()).toEqual(header)
      expect(await alice.locator('.composer').boundingBox()).toEqual(composer)
    }

    await conversationAction(alice, 'Add people')
    await expect(alice.locator('.details-content')).toHaveCSS('overscroll-behavior-y', 'contain')
    await closeDetails(alice)
    if (width <= 640) await alice.getByRole('button', { name: 'Back to conversations' }).click()
    await openSettings(alice)
    await expect(alice.locator('.settings')).toHaveCSS('overscroll-behavior-y', 'contain')
    await alice.context().close()
    await bob.context().close()
  })
}

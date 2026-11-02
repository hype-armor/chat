import { expect } from '@playwright/test'
import { test, closeDetails, conversationAction, conversationDetails, linkDevice, messages, openChat, randomUsername, signUp, startChat } from './support'

test.skip(!process.env.E2E_SERVER, 'needs chat-server and PostgreSQL (set E2E_SERVER=1 and DATABASE_URL)')

test('safety numbers match, and a new device of a verified contact is flagged (ADR-0020)', async ({ browser }) => {
  test.setTimeout(120_000) // three browser contexts plus a device link; WebKit on CI is slow
  expect(browser.contexts()).toHaveLength(0)
  const bobUsername = randomUsername()
  const alice = await signUp(browser, 'Alice', randomUsername())
  const bob = await signUp(browser, 'Bob', bobUsername)
  const activity = await bob.evaluateHandle(`(() => {
    const counts = { resize: 0, frames: 0, mutations: 0 }
    const Observer = window.ResizeObserver
    window.ResizeObserver = class extends Observer {
      constructor(callback) {
        super((entries, observer) => {
          counts.resize++
          callback(entries, observer)
        })
      }
    }
    const frame = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (callback) => frame((time) => {
      counts.frames++
      callback(time)
    })
    const mutations = new MutationObserver(() => counts.mutations++)
    mutations.observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true })
    return counts
  })()`)
  await startChat(alice, bobUsername)
  await expect(alice.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 15_000 })
  await alice.getByLabel('Message').fill('Hi Bob')
  await alice.getByRole('button', { name: 'Send' }).click()
  await expect(alice.getByRole('heading', { name: 'Bob' })).toBeVisible()
  await openChat(bob, /Alice/)
  await expect(messages(bob)).toHaveText([/Hi Bob/])

  // Both see the same 60 digits.
  await conversationAction(alice, 'Verify safety number')
  await conversationAction(bob, 'Verify safety number')
  await expect(conversationDetails(alice).getByTestId('safety-number')).toBeVisible()
  const number = (await alice.getByTestId('safety-number').textContent())!.trim()
  expect(number).toMatch(/^(\d{5} ){11}\d{5}$/)
  await expect(bob.getByTestId('safety-number')).toHaveText(number)
  await alice.getByRole('button', { name: 'Mark as verified' }).click()
  await expect(alice.locator('.conversation header .badge')).toHaveText('Verified')
  await closeDetails(bob)
  await test.step('layout activity settles after closing details', async () => {
    const counts = await activity.evaluate(async (counts: { resize: number; frames: number; mutations: number }) => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      counts.resize = counts.frames = counts.mutations = 0
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return { ...counts }
    })
    console.log('Bob idle layout activity:', counts)
    expect(counts.resize).toBeLessThanOrEqual(5)
    expect(counts.frames).toBeLessThanOrEqual(5)
    expect(counts.mutations).toBeLessThanOrEqual(5)
  })

  // Bob links a laptop: Alice is told, and her verification no longer holds.
  const laptop = await linkDevice(browser, bob)
  await expect(alice.getByTestId('notice')).toHaveText("Bob's safety number changed: a device was added.", {
    timeout: 15_000,
  })
  await expect(alice.locator('.conversation header .badge')).toHaveText('Changed')
  await expect(alice.getByRole('note')).toContainText('safety number changed since you verified it')
  await conversationAction(alice, 'Verify safety number')
  await expect(alice.getByTestId('safety-number')).not.toHaveText(number)

  // Bob approved the laptop himself, so neither of his devices raises an alert.
  await expect(bob.getByRole('alert')).toHaveCount(0)
  await expect(laptop.getByRole('alert')).toHaveCount(0)
})

import { expect, test } from './fixtures'

// These tests check the boundary between 2 tests in the same worker.
test.describe.configure({ mode: 'serial' })

test('a test can create multiple client contexts and close one early', async ({ browser }) => {
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  await alice.newPage()
  await bob.newPage()
  await alice.close()
  expect(browser.contexts()).toHaveLength(1)
  // Leave Bob open, as the messaging tests do. The cleanup must close it.
})

test('the next test starts without client contexts from the previous test', async ({ browser }) => {
  expect(browser.contexts()).toHaveLength(0)
})

import { expect, test } from '@playwright/test'
import './support'

test.afterEach(async ({ browser }) => {
  expect(browser.contexts()).toHaveLength(0)
})

test('manually created contexts are closed at test teardown', async ({ browser }) => {
  await browser.newContext()
  await browser.newContext()
  expect(browser.contexts()).toHaveLength(2)
})

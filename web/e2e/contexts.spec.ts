import { expect } from '@playwright/test'
import { test } from './support'

test('create manual contexts without explicitly closing them', async ({ browser }) => {
  expect(browser.contexts()).toHaveLength(0)
  await browser.newContext()
  await browser.newContext()
  expect(browser.contexts()).toHaveLength(2)
})

test('the next test starts without contexts from previous tests', async ({ browser }) => {
  expect(browser.contexts()).toHaveLength(0)
})

import { test as base } from '@playwright/test'

export * from '@playwright/test'

// The browser fixture lives for a worker, not a test. Messaging tests create
// several contexts directly, outside Playwright's managed context fixture.
// Close them after every test, including failures, so pages, core workers and
// sockets do not accumulate while the worker runs the rest of the suite.
export const test = base.extend<{ clientContexts: void }>({
  clientContexts: [async ({ browser }, use) => {
    await use()
    await Promise.all(browser.contexts().map((context) => context.close()))
  }, { auto: true }],
})

import { expect, test } from './fixtures'

test.skip(!process.env.E2E_UI_FIXTURES, 'requires an isolated fixture origin; never use a live deployment')

test('worker storage recovers closed native IndexedDB connections without losing drafts or keys', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('The isolated fixture origin is required')
  const origin = new URL(baseURL).origin
  const prohibited: string[] = []
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin || url.pathname.startsWith('/v1/')) {
      prohibited.push(url.href)
      await route.abort('blockedbyclient')
    } else await route.continue()
  })
  const harness = '/e2e/storage-reconnect-harness.html'
  await context.route(`**${harness}`, (route) => route.fulfill({
    contentType: 'text/html',
    headers: {
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; require-trusted-types-for 'script'; trusted-types chat default",
    },
    body: '<!doctype html><html><head><meta charset="UTF-8"><title>Worker reconnect regression</title></head><body>Worker-only storage harness</body></html>',
  }))
  await context.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new Error('UI IndexedDB access is forbidden') } })
  })
  await page.goto(harness)
  const result = await page.evaluate(async () => {
    const policyModule = '/src/trusted-types.ts'
    const workerModule = '/src/test-fixtures/storage-reconnect.worker.ts?worker&url'
    const { scriptUrl } = await import(policyModule)
    const { default: workerUrl } = await import(workerModule)
    const worker = new Worker(scriptUrl(workerUrl), { type: 'module' })
    try {
      return await new Promise<unknown>((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message || 'Storage worker failed'))
        worker.onmessageerror = () => reject(new Error('Storage worker response could not be cloned'))
        worker.onmessage = ({ data }) => resolve(data)
        worker.postMessage({})
      })
    } finally { worker.terminate() }
  })
  expect(result).toEqual({
    restored: { text: '  private reconnect draft\n', revision: 18 },
    deleted: true,
    cleared: true,
    file: 'sealed attachment',
    keyPreserved: true,
  })
  expect(prohibited).toEqual([])
})

import { expect, test, type Page } from './fixtures'

// Keep the browser harness wire shape local. The Node test project must not
// import the application/worker project, even through a type-only import.
type Draft = { text: string; revision: number }
type DraftStorageRequest = { id: number } & ({ type: 'write'; draft: Draft } | { type: 'read' })
type DraftStorageReply = {
  id: number
  draft?: Draft
  inspection?: { sealedBytes: boolean; plaintextPresent: boolean; nonExtractableStorageKey: boolean }
  error?: string
}

test.skip(!process.env.E2E_UI_FIXTURES, 'requires the isolated fixture origin; never use a live chat deployment')

const harness = '/e2e/draft-storage-harness.html'
const draft: Draft = { text: '  draft-storage-regression-private-marker\n\n  Keep spaces and a tab\t \n', revision: 17 }

async function requestWorker(page: Page, request: DraftStorageRequest) {
  return page.evaluate(async (request): Promise<DraftStorageReply & { keyEscaped: boolean }> => {
    // All storage and key inspection remain in the worker. The page only uses RPC.
    const policyModule = '/src/trusted-types.ts'
    const workerModule = '/src/test-fixtures/draft-storage.worker.ts?worker&url'
    const { scriptUrl } = await import(policyModule)
    const { default: workerUrl } = await import(workerModule)
    const worker = new Worker(scriptUrl(workerUrl), { type: 'module' })
    // Retain the dedicated worker until this page closes, not just until RPC ends.
    ;(window as unknown as { draftStorageWorker: Worker }).draftStorageWorker = worker
    return new Promise((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message || 'Draft storage worker failed'))
      worker.onmessageerror = () => reject(new Error('Draft storage worker response could not be cloned'))
      worker.onmessage = ({ data }: MessageEvent<DraftStorageReply>) => {
        if (data.id !== request.id) return reject(new Error('Unexpected draft storage response'))
        const containsKey = (value: unknown): boolean => value instanceof CryptoKey || (
          value !== null && typeof value === 'object' && Object.values(value).some(containsKey)
        )
        resolve({ ...data, keyEscaped: containsKey(data) })
      }
      worker.postMessage(request)
    })
  }, request)
}

test('real encrypted draft storage survives page and dedicated-worker termination in the same browser context', async ({ page, context, baseURL }) => {
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
  await context.route(`**${harness}`, (route) => route.fulfill({
    contentType: 'text/html',
    headers: {
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; require-trusted-types-for 'script'; trusted-types chat default",
    },
    body: '<!doctype html><html><head><meta charset="UTF-8"><title>Worker storage regression</title></head><body>Worker-only storage harness</body></html>',
  }))
  await context.addInitScript(() => {
    // The production worker has its own global. Any accidental UI IndexedDB use fails.
    Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new Error('UI IndexedDB access is forbidden in this regression') } })
  })

  await page.goto(harness)
  const first = await test.step('write and inspect encrypted IndexedDB through the first worker', () => requestWorker(page, { id: 1, type: 'write', draft }))
  const expected = {
    id: 1,
    draft,
    inspection: { sealedBytes: true, plaintextPresent: false, nonExtractableStorageKey: true },
    keyEscaped: false,
  }
  expect(first).toEqual(expected)
  await test.step('terminate the native worker and close its owning page', async () => {
    // Firefox reports creation but does not report this dedicated worker's close
    // through Playwright. Use the native termination API, not an observer event.
    const terminated = await page.evaluate(() => {
      const scope = window as unknown as { draftStorageWorker?: Worker }
      if (!(scope.draftStorageWorker instanceof Worker)) return false
      scope.draftStorageWorker.terminate()
      delete scope.draftStorageWorker
      return true
    })
    expect(terminated).toBe(true)
    await page.close()
    expect(page.isClosed()).toBe(true)
  })

  // A distinct page and worker must reopen actual IndexedDB, not reuse JS state.
  const reopened = await context.newPage()
  await reopened.goto(harness)
  // requestWorker always calls the native constructor. Neither page nor worker
  // JS state can survive the explicit termination and owning-page closure.
  const restored = await test.step('reopen and decrypt IndexedDB in a new page and worker', () => requestWorker(reopened, { id: 1, type: 'read' }))
  expect(restored).toEqual(expected)
  expect(restored.draft?.text).toBe(draft.text)
  expect(restored.draft?.revision).toBe(17)
  expect(prohibited).toEqual([])
  await reopened.close()
})

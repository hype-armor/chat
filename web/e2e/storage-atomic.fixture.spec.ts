import { expect, test } from './fixtures'

test('native IndexedDB fences concurrent writers, rolls back aborts, and completes durable writes', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('An isolated fixture origin is required')
  const origin = new URL(baseURL).origin
  const prohibited: string[] = []
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin || url.pathname.startsWith('/v1/')) {
      prohibited.push(url.href)
      await route.abort('blockedbyclient')
    } else await route.continue()
  })
  await page.goto('/e2e/storage-atomic-fixture.html')
  const result = await page.evaluate(async () => {
    const modulePath = '/src/test-fixtures/storage-atomic.worker.ts?worker&url'
    const { default: url } = await import(modulePath)
    const worker = new Worker(url, { type: 'module' })
    try {
      return await new Promise<any>((resolve, reject) => {
        worker.onerror = event => reject(new Error(event.message))
        worker.onmessageerror = () => reject(new Error('Worker response could not be cloned'))
        worker.onmessage = event => resolve(event.data)
        worker.postMessage(null)
      })
    } finally { worker.terminate() }
  })
  expect(result.error).toBeUndefined()
  expect(result.serializedKey).toBe(true)
  expect(result.crossReads).toEqual({ fromFirst: 'first secret', fromSecond: 'second secret' })
  expect(result.invalid).toHaveLength(2)
  expect(result.invalid.every((error: string) => error.includes('Invalid storage revision'))).toBe(true)
  expect(result.initial).toBe(0)
  expect(result.statuses.sort()).toEqual(['fulfilled', 'rejected'])
  expect(result.rejected).toHaveLength(1)
  expect(result.rejected[0]).toContain('Stale storage revision')
  expect(result.abortInjected).toBe(true)
  expect(result.abortError).toBeTruthy()
  expect(result.afterAbort).toEqual({ revision: 1, kv: result.winner, file: result.winner })
  expect(result.completedOnReturn).toBe(true)
  expect(result.durable).toEqual({ revision: 2, kv: 'durable', file: 'durable' })
  expect(prohibited).toEqual([])
})

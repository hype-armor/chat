import { expect, test } from './fixtures'

test('delivery adapter persists encrypted atomic state and rejects invalid retries after reload', async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error('An isolated fixture origin is required')
  const origin = new URL(baseURL).origin
  const prohibited: string[] = []
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin || url.pathname.startsWith('/v1/')) { prohibited.push(url.href); await route.abort('blockedbyclient') }
    else await route.continue()
  })
  await page.goto('/e2e/delivery-store-fixture.html')
  const first = await page.evaluate(async () => {
    const path = '/src/test-fixtures/delivery-store.ts'
    return (await import(path)).commitAndAbort()
  })
  expect(first.committed).toBe('committed')
  expect(first.injected).toBe(true)
  expect(first.aborted).toBeTruthy()
  expect(first.stale).toContain('Stale storage revision')
  await page.reload()
  const result = await page.evaluate(async () => {
    const path = '/src/test-fixtures/delivery-store.ts'
    return (await import(path)).inspectAfterReload()
  })
  expect(result.revision).toBe(1)
  expect(result.finalRevision).toBe(1)
  expect(result.core).toBe('private core value')
  expect(result.ledger.entries).toHaveLength(1)
  expect(result.ledger.entries[0].intents).toEqual([{ id: 'intent', kind: 'notify', payload: 'private intent value' }])
  expect(result.duplicate).toBe('duplicate')
  expect(result.mismatch).toContain('Delivery envelope mismatch')
  expect(result.account).toContain('Delivery binding mismatch')
  expect(result.session).toContain('Delivery binding mismatch')
  for (const value of result.ciphertext) {
    expect(value.bytes).toBe(true)
    expect(value.text).not.toContain('private core value')
    expect(value.text).not.toContain('private intent value')
  }
  expect(prohibited).toEqual([])
})

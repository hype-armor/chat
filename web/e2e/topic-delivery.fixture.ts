import { expect, test } from './fixtures'

test('disabled topic aborts before commit and replays in a clean worker over the same IndexedDB', async ({ page, context, baseURL }) => {
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
  await page.goto('/e2e/topic-delivery-fixture.html')
  // Every command uses a new dedicated worker. Termination discards the failed
  // Engine, MLS memory, SecureStore connection, and prototype injection.
  const command = (name: string) => page.evaluate(async command => {
    const worker = new Worker('/src/test-fixtures/topic-delivery.worker.ts', { type: 'module' })
    try {
      return await new Promise<{
        error: string; digest: string; injected: boolean; acknowledgements: number; closes: number;
        order: string[]; ackCoreReadback: boolean; ackAppReadback: boolean; coreUnchanged: boolean; appUnchanged: boolean;
        ciphertextUnchanged: boolean; conversationUnchanged: boolean; messageSeen: boolean; noTopic: boolean;
        noHistory: boolean; replayError: string; laterText: string;
      }>((resolve, reject) => {
        worker.onerror = event => reject(new Error(event.message))
        worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result)
        worker.postMessage(command)
      })
    } finally { worker.terminate() }
  }, name)
  const seed = await command('seed')
  const failed = await command('abort')
  expect(failed.digest).toBe(seed.digest)
  expect(failed.injected).toBe(true)
  expect(failed.error).toBeTruthy()
  expect(failed.acknowledgements).toBe(0)
  expect(failed.closes).toBe(1)
  expect(failed.order).toEqual([])
  expect(failed.coreUnchanged).toBe(true)
  expect(failed.appUnchanged).toBe(true)
  expect(failed.messageSeen).toBe(false)
  expect(failed.ciphertextUnchanged).toBe(true)
  expect(failed.conversationUnchanged).toBe(true)
  expect(failed.noTopic).toBe(true)
  expect(failed.noHistory).toBe(true)
  // The aborted ratchet snapshot still accepts the exact topic ciphertext.
  expect(failed.replayError).toBe('')

  const accepted = await command('replay')
  expect(accepted.digest).toBe(seed.digest)
  expect(accepted.error).toBe('')
  expect(accepted.injected).toBe(false)
  expect(accepted.acknowledgements).toBe(1)
  expect(accepted.closes).toBe(0)
  expect(accepted.order).toEqual(['commit', 'ack'])
  expect(accepted.ackCoreReadback).toBe(true)
  expect(accepted.ackAppReadback).toBe(true)
  expect(accepted.coreUnchanged).toBe(false)
  expect(accepted.appUnchanged).toBe(false)
  expect(accepted.messageSeen).toBe(true)
  expect(accepted.ciphertextUnchanged).toBe(false)
  expect(accepted.conversationUnchanged).toBe(true)
  expect(accepted.noTopic).toBe(true)
  expect(accepted.noHistory).toBe(true)
  expect(accepted.replayError).toBeTruthy()
  expect(accepted.laterText).toBe('ordinary text after topic')
  expect(prohibited).toEqual([])
})

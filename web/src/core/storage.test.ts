import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecureStore } from './storage'

type Request = {
  result: unknown
  error: DOMException | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

function database() {
  const transactions: ReturnType<typeof transaction>[] = []
  function transaction() {
    const requests: Request[] = []
    const values: unknown[] = []
    const operation = (value?: unknown) => {
      const req: Request = { result: undefined, error: null, onsuccess: null, onerror: null }
      requests.push(req)
      values.push(value)
      return req
    }
    return {
      requests, values,
      error: null as DOMException | null,
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore: () => ({ put: operation, delete: operation, clear: operation, get: operation }),
      succeed() { for (const req of requests) req.onsuccess?.() },
      commit() { this.oncomplete?.() },
      abort() { this.error = new DOMException('Aborted', 'AbortError'); this.onabort?.() },
    }
  }
  const db = { transaction: () => { const tx = transaction(); transactions.push(tx); return tx } }
  return { db, transactions }
}

async function setup() {
  const { db, transactions } = database()
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  // Exercise the real storage methods with a controlled IndexedDB lifecycle.
  const store = Reflect.construct(SecureStore, [db, key]) as SecureStore
  return { store, key, transactions }
}

afterEach(() => vi.unstubAllGlobals())

describe('SecureStore durable acknowledgement', () => {
  it('does not open a fresh store until its encryption key transaction commits', async () => {
    const { db, transactions } = database()
    const opening: Request = { result: db, error: null, onsuccess: null, onerror: null }
    vi.stubGlobal('indexedDB', { open: () => opening })
    let settled = false
    const loading = SecureStore.open().then((store) => { settled = true; return store })
    opening.onsuccess?.()
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    transactions[0].succeed() // No existing storage key.
    await vi.waitFor(() => expect(transactions).toHaveLength(2))
    const creating = transactions[1]
    expect(creating.values[0]).toBeInstanceOf(CryptoKey)
    creating.succeed()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    creating.commit()
    await expect(loading).resolves.toBeInstanceOf(SecureStore)
  })

  it('rejects first open if storage-key creation aborts after request success', async () => {
    const { db, transactions } = database()
    const opening: Request = { result: db, error: null, onsuccess: null, onerror: null }
    vi.stubGlobal('indexedDB', { open: () => opening })
    const loading = SecureStore.open()
    const rejected = expect(loading).rejects.toThrow('Aborted')
    opening.onsuccess?.()
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    transactions[0].succeed()
    await vi.waitFor(() => expect(transactions).toHaveLength(2))
    transactions[1].succeed()
    transactions[1].abort()
    await rejected
  })

  it.each(['put', 'delete'] as const)('waits for a key %s transaction to complete', async (operation) => {
    const { store, key, transactions } = await setup()
    let settled = false
    const writing = store.putKey('backup', operation === 'put' ? key : undefined).then(() => { settled = true })
    transactions[0].succeed()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    transactions[0].commit()
    await writing
    expect(settled).toBe(true)
  })

  it('rejects a key write if its transaction aborts after request success', async () => {
    const { store, key, transactions } = await setup()
    const writing = store.putKey('backup', key)
    const rejected = expect(writing).rejects.toThrow('Aborted')
    transactions[0].succeed()
    transactions[0].abort()
    await rejected
  })

  it('encrypts values and waits beyond request success until transaction completion', async () => {
    const { store, transactions } = await setup()
    let settled = false
    const writing = store.putJson('draft:local:chat', { text: 'private draft', revision: 1 }).then(() => { settled = true })
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    const tx = transactions[0]
    const sealed = tx.values[0] as Uint8Array
    expect(sealed).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(sealed)).not.toContain('private draft')
    tx.succeed()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    tx.commit()
    await writing
    expect(settled).toBe(true)
  })

  it('rejects a transaction abort even after its write request succeeded', async () => {
    const { store, transactions } = await setup()
    const writing = store.putBytes('app', new Uint8Array([1, 2, 3]))
    const rejected = expect(writing).rejects.toThrow('Aborted')
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    transactions[0].succeed()
    transactions[0].abort()
    await rejected
  })

  it('waits for encrypted-record deletion to commit', async () => {
    const { store, transactions } = await setup()
    let settled = false
    const deleting = store.deleteBytes('draft:local:chat').then(() => { settled = true })
    transactions[0].succeed()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    transactions[0].commit()
    await deleting
    expect(settled).toBe(true)
  })

  it('waits for the sealed attachment body to commit before local acceptance', async () => {
    const { store, transactions } = await setup()
    let settled = false
    const writing = store.putFile('attachment', new Blob(['sealed body'])).then(() => { settled = true })
    transactions[0].succeed()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    transactions[0].commit()
    await writing
    expect(settled).toBe(true)
  })
})

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

function recoveryDatabase(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial))
  const transactions: Array<{
    requests: Request[]
    succeed(): void
    commit(): void
    abort(): void
    oncomplete: (() => void) | null
    onabort: (() => void) | null
    error: DOMException | null
  }> = []
  const db = {
    onversionchange: null as (() => void) | null,
    close: vi.fn(),
    transaction: vi.fn(() => {
      const requests: Request[] = []
      const tx = {
        requests,
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        error: null as DOMException | null,
        objectStore: () => ({
          get: (name: string) => {
            const req: Request = { result: values.get(name), error: null, onsuccess: null, onerror: null }
            requests.push(req)
            return req
          },
          put: (value: unknown, name: string) => {
            values.set(name, value)
            const req: Request = { result: name, error: null, onsuccess: null, onerror: null }
            requests.push(req)
            return req
          },
          delete: (name: string) => {
            values.delete(name)
            const req: Request = { result: undefined, error: null, onsuccess: null, onerror: null }
            requests.push(req)
            return req
          },
          clear: () => {
            const req: Request = { result: undefined, error: null, onsuccess: null, onerror: null }
            requests.push(req)
            return req
          },
        }),
        succeed() { for (const req of requests) req.onsuccess?.() },
        commit() { this.oncomplete?.() },
        abort() { this.error = new DOMException('Aborted', 'AbortError'); this.onabort?.() },
      }
      transactions.push(tx)
      return tx
    }),
  }
  return { db, transactions, values }
}

async function reconnect(store: SecureStore, reopened: ReturnType<typeof recoveryDatabase>) {
  const opening: Request & { onupgradeneeded?: (() => void) | null } = {
    result: reopened.db, error: null, onsuccess: null, onerror: null, onupgradeneeded: null,
  }
  vi.stubGlobal('indexedDB', { open: vi.fn(() => opening) })
  const liveDb = (store as unknown as { db: { transaction: (...args: unknown[]) => unknown } }).db
  vi.spyOn(liveDb, 'transaction').mockImplementation(() => {
    throw new DOMException('Connection is closed', 'InvalidStateError')
  })
  return opening
}

async function finishRead(tx: ReturnType<typeof recoveryDatabase>['transactions'][number]) {
  tx.succeed()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => vi.unstubAllGlobals())

describe('SecureStore connection recovery', () => {
  async function recoveredStore(persistedKey?: CryptoKey) {
    const initial = recoveryDatabase({ storage: persistedKey })
    const key = persistedKey ?? await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    )
    const store = Reflect.construct(SecureStore, [initial.db, key]) as SecureStore
    const reopened = recoveryDatabase(persistedKey ? { storage: persistedKey } : {})
    const opening = await reconnect(store, reopened)
    return { store, initial, reopened, opening, key }
  }

  it('reopens with the same persisted key and completes the pending operation', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const { store, reopened, opening } = await recoveredStore(key)
    const write = store.putBytes('recover', new Uint8Array([4, 5, 6]))
    await vi.waitFor(() => expect((store as unknown as { db: { transaction: ReturnType<typeof vi.fn> } }).db.transaction).toHaveBeenCalled())
    opening.onsuccess?.()
    await vi.waitFor(() => expect(reopened.transactions).toHaveLength(1))
    await finishRead(reopened.transactions[0])
    await vi.waitFor(() => expect(reopened.transactions).toHaveLength(2))
    const pending = reopened.transactions[1]
    pending.succeed()
    pending.commit()
    await write
    expect(reopened.values.has('recover')).toBe(true)
  })

  it('coalesces concurrent reconnect attempts', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const { store, reopened, opening } = await recoveredStore(key)
    const one = store.putBytes('one', new Uint8Array([1]))
    const two = store.putBytes('two', new Uint8Array([2]))
    await vi.waitFor(() => expect((store as unknown as { db: { transaction: ReturnType<typeof vi.fn> } }).db.transaction).toHaveBeenCalled())
    opening.onsuccess?.()
    await vi.waitFor(() => expect(reopened.transactions).toHaveLength(1))
    await finishRead(reopened.transactions[0])
    await vi.waitFor(() => expect(reopened.transactions).toHaveLength(3))
    for (const tx of reopened.transactions.slice(1)) { tx.succeed(); tx.commit() }
    await Promise.all([one, two])
    expect(indexedDB.open).toHaveBeenCalledOnce()
    expect(reopened.db.transaction).toHaveBeenCalledTimes(3)
  })

  it.each(['missing', 'changed'] as const)('rejects recovery when the key is %s and closes the reopened database', async (condition) => {
    const cached = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const persisted = condition === 'changed'
      ? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      : undefined
    const { store, reopened, opening } = await recoveredStore(cached)
    if (condition === 'changed') reopened.values.set('storage', persisted)
    else reopened.values.delete('storage')
    const write = store.putBytes('unsafe', new Uint8Array([9]))
    const rejected = expect(write).rejects.toThrow(condition === 'missing' ? /key is missing/ : /key changed/)
    await vi.waitFor(() => expect((store as unknown as { db: { transaction: ReturnType<typeof vi.fn> } }).db.transaction).toHaveBeenCalled())
    opening.onsuccess?.()
    await vi.waitFor(() => expect(reopened.transactions).toHaveLength(1))
    await finishRead(reopened.transactions[0])
    await rejected
    expect(reopened.db.close).toHaveBeenCalledOnce()
    expect(reopened.transactions).toHaveLength(1)
  })

  it('does not retry transaction errors other than InvalidStateError', async () => {
    const { store, initial } = await recoveredStore()
    const error = new DOMException('Denied', 'SecurityError')
    vi.mocked(initial.db.transaction).mockImplementationOnce(() => { throw error })
    await expect(store.getBytes('x')).rejects.toBe(error)
  })

  it('retries transaction creation only once', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const { store, reopened, opening } = await recoveredStore(key)
    const create = reopened.db.transaction.getMockImplementation()!
    reopened.db.transaction.mockImplementationOnce(create).mockImplementation(() => {
      throw new DOMException('Still closed', 'InvalidStateError')
    })
    const read = store.getBytes('x')
    const rejected = expect(read).rejects.toThrow('Still closed')
    opening.onsuccess?.()
    await vi.waitFor(() => expect(reopened.transactions).toHaveLength(1))
    expect(reopened.db.onversionchange).toBeTypeOf('function')
    await finishRead(reopened.transactions[0])
    await rejected
    expect(reopened.db.transaction).toHaveBeenCalledTimes(2)
  })

  it('closes the connection on version change', async () => {
    const initial = recoveryDatabase()
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    Reflect.construct(SecureStore, [initial.db, key])
    initial.db.onversionchange?.()
    expect(initial.db.close).toHaveBeenCalledOnce()
  })

  it('does not reconnect or replay a transaction that already started and aborts', async () => {
    const initial = recoveryDatabase()
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const store = Reflect.construct(SecureStore, [initial.db, key]) as SecureStore
    const opening = { open: vi.fn() }
    vi.stubGlobal('indexedDB', opening)
    const write = store.putBytes('once', new Uint8Array([1]))
    await vi.waitFor(() => expect(initial.transactions).toHaveLength(1))
    initial.transactions[0].succeed()
    initial.transactions[0].abort()
    await expect(write).rejects.toThrow('Aborted')
    expect(opening.open).not.toHaveBeenCalled()
    expect(initial.transactions).toHaveLength(1)
  })
})

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
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
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
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
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
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
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
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    transactions[0].succeed()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    transactions[0].commit()
    await writing
    expect(settled).toBe(true)
  })
})

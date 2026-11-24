import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecureStore } from './storage'

// This model keeps writes private until commit, as IndexedDB transactions do.
function database() {
  const records = new Map<string, Uint8Array>()
  const transactions: Array<{
    commit(): void; abort(): void; succeed(): void
    oncomplete: (() => void) | null; onabort: (() => void) | null; error: DOMException | null
  }> = []
  let throwOnPut = 0
  const db = {
    onversionchange: null,
    transaction: vi.fn(() => {
      const changes = new Map<string, Uint8Array | undefined>()
      const requests: Array<{ result: unknown; error: null; onsuccess: (() => void) | null; onerror: (() => void) | null }> = []
      let puts = 0
      const tx = {
        oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, error: null as DOMException | null,
        objectStore: () => ({
          put(value: Uint8Array, name: string) {
            if (++puts === throwOnPut) throw new DOMException('put failed', 'DataError')
            changes.set(name, value)
            const req = { result: name as unknown, error: null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
            requests.push(req)
            return req
          },
          delete(name: string) {
            if (++puts === throwOnPut) throw new DOMException('delete failed', 'DataError')
            changes.set(name, undefined)
            const req = { result: undefined as unknown, error: null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
            requests.push(req)
            return req
          },
          get(name: string) {
            const req = { result: records.get(name) as unknown, error: null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
            requests.push(req)
            queueMicrotask(() => req.onsuccess?.())
            return req
          },
        }),
        succeed() { requests.forEach((req) => req.onsuccess?.()) },
        commit() { for (const [name, value] of changes) { if (value === undefined) records.delete(name); else records.set(name, value) }; this.oncomplete?.() },
        abort() { this.error = new DOMException('Aborted', 'AbortError'); this.onabort?.() },
      }
      transactions.push(tx)
      return tx
    }),
  }
  return { db, records, transactions, failPut(n: number) { throwOnPut = n } }
}

async function setup() {
  const model = database()
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const open = () => Reflect.construct(SecureStore, [model.db, key]) as SecureStore
  return { ...model, open }
}
const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array | undefined) => value && new TextDecoder().decode(value)

afterEach(() => vi.restoreAllMocks())

describe('encrypted atomic batches', () => {
  it('replaces existing records together and reloads through the existing readers', async () => {
    const { open, records, transactions } = await setup()
    const store = open()
    const old = store.putJson('app', { topic: 'old' })
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    transactions[0].succeed(); transactions[0].commit(); await old
    const write = store.putBatch([['core', encode('ratchet')], ['app', encode(JSON.stringify({ topic: 'private' }))]])
    await vi.waitFor(() => expect(transactions).toHaveLength(2))
    let settled = false
    void write.then(() => { settled = true })
    transactions[1].succeed()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(await open().getJson('app')).toEqual({ topic: 'old' })
    expect(records.has('core')).toBe(false)
    transactions[1].commit(); await write
    expect(new TextDecoder().decode(records.get('app'))).not.toContain('private')
    expect(decode(await open().getBytes('core'))).toBe('ratchet')
    expect(await open().getJson('app')).toEqual({ topic: 'private' })
  })

  it('does not start a transaction if encryption fails', async () => {
    const { open, transactions } = await setup()
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('encryption failed'))
    await expect(open().putBatch([['core', encode('x')], ['app', encode('y')]])).rejects.toThrow('encryption failed')
    expect(transactions).toHaveLength(0)
  })

  it('keeps the old records after an abort following request success', async () => {
    const { open, transactions } = await setup()
    const store = open()
    const initial = store.putBatch([['core', encode('old core')], ['app', encode('old app')]])
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    transactions[0].succeed(); transactions[0].commit(); await initial
    const write = store.putBatch([['core', encode('new core')], ['app', encode('new app')]])
    const rejected = expect(write).rejects.toThrow('Aborted')
    await vi.waitFor(() => expect(transactions).toHaveLength(2))
    transactions[1].succeed(); transactions[1].abort(); await rejected
    expect(decode(await open().getBytes('core'))).toBe('old core')
    expect(decode(await open().getBytes('app'))).toBe('old app')
  })

  it('aborts earlier writes if a later put throws synchronously', async () => {
    const { open, transactions, records, failPut } = await setup()
    failPut(2)
    await expect(open().putBatch([['core', encode('x')], ['app', encode('y')]])).rejects.toThrow('put failed')
    expect(transactions).toHaveLength(1)
    expect(records.size).toBe(0)
  })

  it('atomically removes a journal with replacement snapshots, including abort and retry', async () => {
    const { open, transactions } = await setup()
    const store = open()
    const initial = store.updateBatch([['journal', encode('pending')], ['core', encode('old')]])
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    transactions[0].succeed(); transactions[0].commit(); await initial
    const update = () => store.updateBatch([['core', encode('new')], ['journal', undefined]])
    const failed = update()
    const rejected = expect(failed).rejects.toThrow('Aborted')
    await vi.waitFor(() => expect(transactions).toHaveLength(2))
    transactions[1].succeed(); transactions[1].abort(); await rejected
    expect(decode(await open().getBytes('journal'))).toBe('pending')
    expect(decode(await open().getBytes('core'))).toBe('old')
    const retry = update()
    await vi.waitFor(() => expect(transactions).toHaveLength(5))
    transactions[4].succeed(); transactions[4].commit(); await retry
    expect(await open().getBytes('journal')).toBeUndefined()
    expect(decode(await open().getBytes('core'))).toBe('new')
  })

  it('rejects duplicate keys without opening a transaction', async () => {
    const { open, transactions } = await setup()
    await expect(open().putBatch([['app', encode('x')], ['app', encode('y')]])).rejects.toThrow('Duplicate')
    expect(transactions).toHaveLength(0)
  })
})

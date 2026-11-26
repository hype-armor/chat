import { describe, expect, it, vi } from 'vitest'
import { SecureStore } from './storage'

// A transaction model with private writes and explicit completion/abort.
async function setup() {
  const data = new Map<string, unknown>()
  const transactions: Array<{ succeed(): void; commit(): void; abort(): void }> = []
  const db = {
    onversionchange: null,
    transaction: vi.fn(() => {
      const changes = new Map<string, unknown>()
      const pending: Array<() => void> = []
      const tx = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        error: null as DOMException | null,
        objectStore(store: string) {
          const id = (key: unknown) => JSON.stringify([store, key])
          const req = (result: unknown) => {
            const r = { result, error: null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null }
            pending.push(() => r.onsuccess?.())
            return r
          }
          return {
            get(key: unknown) { const r = req(data.get(id(key))); queueMicrotask(() => pending.shift()?.()); return r },
            getKey(key: unknown) { const r = req(data.has(id(key)) ? key : undefined); queueMicrotask(() => pending.shift()?.()); return r },
            put(value: unknown, key: unknown) { changes.set(id(key), value); return req(key) },
            delete(key: unknown) { changes.set(id(key), undefined); return req(undefined) },
          }
        },
        succeed() { while (pending.length) pending.shift()?.() },
        commit() { for (const [key, value] of changes) { if (value === undefined) data.delete(key); else data.set(key, value) }; this.oncomplete?.() },
        abort() { this.error = new DOMException('Aborted', 'AbortError'); this.onabort?.() },
      }
      transactions.push(tx)
      return tx
    }),
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const store = Reflect.construct(SecureStore, [db, key]) as SecureStore
  return { store, data, transactions }
}
const key = (store: string, name: unknown) => JSON.stringify([store, name])
const mutations = () => [
  { store: 'kv' as const, name: 'app', value: new TextEncoder().encode('secret') },
  { store: 'files' as const, name: 'file', value: new Blob(['sealed']) },
]

describe('revision-fenced atomic storage', () => {
  it('commits encrypted records, files and the revision together, only after completion', async () => {
    const { store, data, transactions } = await setup()
    const write = store.atomicUpdate('delivery', 0, mutations())
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    await vi.waitFor(() => expect(transactions[0]).toBeDefined())
    let finished = false
    void write.then(() => { finished = true })
    transactions[0].succeed(); await Promise.resolve()
    expect(finished).toBe(false)
    expect(data.size).toBe(0)
    transactions[0].commit(); await write
    expect(data.get(key('keys', ['atomic-revision', 'delivery']))).toBe(1)
    expect(new TextDecoder().decode(data.get(key('kv', 'app')) as Uint8Array)).not.toContain('secret')
    expect(new TextDecoder().decode(data.get(key('files', 'file')) as ArrayBuffer)).toBe('sealed')
  })

  it('rolls back all stores after request success and abort', async () => {
    const { store, data, transactions } = await setup()
    const write = store.atomicUpdate('delivery', 0, mutations())
    const failure = expect(write).rejects.toThrow('Aborted')
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    transactions[0].succeed(); transactions[0].abort(); await failure
    expect(data.size).toBe(0)
  })

  it('rejects stale revisions and unsupported mutations without writing', async () => {
    const { store, data, transactions } = await setup()
    data.set(key('keys', ['atomic-revision', 'delivery']), 2)
    await expect(store.atomicUpdate('delivery', 1, mutations())).rejects.toThrow('Stale')
    expect(data.size).toBe(1)
    await expect(store.atomicUpdate('delivery', 2, [{ store: 'keys', name: 'storage', value: undefined }] as never)).rejects.toThrow('Unsupported')
    expect(transactions).toHaveLength(1)
  })

  it.each([undefined, null, -1, 1.5, '1'])('rejects a present invalid revision: %s', async value => {
    const { store, data } = await setup()
    const revisionKey = key('keys', ['atomic-revision', 'delivery'])
    data.set(revisionKey, value)
    await expect(store.atomicRevision('delivery')).rejects.toThrow('Invalid storage revision')
    await expect(store.atomicUpdate('delivery', 0, mutations())).rejects.toThrow('Invalid storage revision')
    expect(data.has(revisionKey)).toBe(true)
    expect(data.get(revisionKey)).toBe(value)
    expect(data.size).toBe(1)
  })

  it('reads an absent revision as zero and rejects an empty fence name', async () => {
    const { store } = await setup()
    await expect(store.atomicRevision('delivery')).resolves.toBe(0)
    await expect(store.atomicRevision('')).rejects.toThrow('Invalid storage revision')
  })
})

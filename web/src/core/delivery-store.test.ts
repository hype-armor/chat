import { describe, expect, it } from 'vitest'
import { commitDelivery } from './delivery-store'
import type { AtomicStorageMutation } from './storage'

function fixture() {
  let revision = 0
  const values = new Map<string, Uint8Array>()
  let fail = false
  let failAfter = false
  const store = {
    async atomicRevision() { return revision },
    async getBytes(name: string) { return values.get(name) },
    async atomicUpdate(_name: string, expected: number, mutations: readonly AtomicStorageMutation[]) {
      if (expected !== revision) throw new Error('Stale storage revision')
      if (fail) throw new Error('Uncertain transaction')
      for (const m of mutations) {
        if (m.store !== 'kv') throw new Error('Unexpected file')
        if (m.value === undefined) values.delete(m.name)
        else values.set(m.name, m.value)
      }
      revision++
      if (failAfter) throw new Error('Uncertain transaction')
    },
  }
  return { store, values, fail: () => { fail = true }, failAfter: () => { failAfter = true } }
}
const input = () => ({ revision: 0, id: 'message', accountId: 'account', sessionGeneration: 'session-1', envelope: new Uint8Array([1, 2, 3]), mutations: [{ store: 'kv' as const, name: 'core', value: new Uint8Array([42]) }], intents: [{ id: 'effect-1', kind: 'notify', payload: 'stable' }] })

describe('delivery store', () => {
  it('commits staged values and durable intents without dispatching effects', async () => {
    const f = fixture()
    expect(await commitDelivery(f.store, input())).toBe('committed')
    expect(f.values.get('core')).toEqual(new Uint8Array([42]))
    const ledger = JSON.parse(new TextDecoder().decode(f.values.get('delivery-acceptance-ledger-v1')))
    expect(ledger.entries[0].intents).toEqual(input().intents)
  })
  it('rejects an uncertain failure without returning success', async () => {
    const f = fixture(); f.fail()
    await expect(commitDelivery(f.store, input())).rejects.toThrow('Uncertain')
    expect(f.values.size).toBe(0)
  })
  it('binds duplicates to the digest and rejects stale revisions', async () => {
    const f = fixture(); await commitDelivery(f.store, input())
    await expect(commitDelivery(f.store, input())).rejects.toThrow('Stale')
    await expect(commitDelivery(f.store, { ...input(), revision: 1 })).resolves.toBe('duplicate')
    await expect(commitDelivery(f.store, { ...input(), revision: 1, envelope: new Uint8Array([1, 2, 4]) })).rejects.toThrow('mismatch')
  })
  it('copies declared intent fields and envelope bytes before awaiting', async () => {
    const f = fixture()
    const data = input()
    const intent = Object.assign(data.intents[0], { extra: 'ignored', toJSON: () => ({ id: 'forged' }) })
    const pending = commitDelivery(f.store, data)
    intent.payload = 'changed'
    data.envelope[0] = 9
    await pending
    const ledger = JSON.parse(new TextDecoder().decode(f.values.get('delivery-acceptance-ledger-v1')))
    expect(ledger.entries[0].intents).toEqual([{ id: 'effect-1', kind: 'notify', payload: 'stable' }])
    expect(ledger.entries[0].digest).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81')
  })
  it('rejects shared envelope and mutation bytes before storage access', async () => {
    const f = fixture()
    const shared = new Uint8Array(new SharedArrayBuffer(8), 2, 3)
    await expect(commitDelivery(f.store, { ...input(), envelope: shared })).rejects.toThrow('Invalid delivery envelope')
    await expect(commitDelivery(f.store, { ...input(), mutations: [{ store: 'kv', name: 'core', value: shared }] })).rejects.toThrow('Unsupported delivery mutation')
    expect(f.values.size).toBe(0)
    expect(await f.store.atomicRevision()).toBe(0)
  })
  it('copies mutation bytes before awaiting', async () => {
    const f = fixture()
    const data = input()
    const pending = commitDelivery(f.store, data)
    data.mutations[0].value[0] = 9
    await pending
    expect(f.values.get('core')).toEqual(new Uint8Array([42]))
  })
  it('rejects invalid or mismatched account and session bindings', async () => {
    const f = fixture()
    await expect(commitDelivery(f.store, { ...input(), accountId: '' })).rejects.toThrow('binding')
    await expect(commitDelivery(f.store, { ...input(), sessionGeneration: '' })).rejects.toThrow('binding')
    await commitDelivery(f.store, input())
    await expect(commitDelivery(f.store, { ...input(), revision: 1, accountId: 'other' })).rejects.toThrow('binding')
    await expect(commitDelivery(f.store, { ...input(), revision: 1, sessionGeneration: 'session-2' })).rejects.toThrow('binding')
  })
  it('allows only one concurrent commit at a revision', async () => {
    const f = fixture()
    const results = await Promise.allSettled([commitDelivery(f.store, input()), commitDelivery(f.store, { ...input(), id: 'other' })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  })
  it('reconciles an uncertain commit before retry', async () => {
    const f = fixture(); f.failAfter()
    await expect(commitDelivery(f.store, input())).rejects.toThrow('Uncertain')
    await expect(commitDelivery(f.store, { ...input(), revision: 1 })).resolves.toBe('duplicate')
  })
  it('rejects malformed ledgers, unsupported mutations and overflow', async () => {
    const f = fixture()
    f.values.set('delivery-acceptance-ledger-v1', new TextEncoder().encode('{}'))
    await expect(commitDelivery(f.store, input())).rejects.toThrow('Malformed')
    f.values.clear()
    await expect(commitDelivery(f.store, { ...input(), mutations: [{ store: 'files', name: 'x', value: undefined }] })).rejects.toThrow('Unsupported')
    await expect(commitDelivery(f.store, { ...input(), intents: [{ id: 'x', kind: 'x', payload: 'x'.repeat(1024 * 1024) }] })).rejects.toThrow('capacity')
    expect(f.values.size).toBe(0)
  })
})

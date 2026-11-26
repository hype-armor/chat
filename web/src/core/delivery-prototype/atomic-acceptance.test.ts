import { describe, expect, it, vi } from 'vitest'
import { ACCEPTANCE_STORES, acceptAtomically, type AcceptanceRecord, type AcceptanceStoreName, type AtomicAcceptanceStore, type AtomicTransaction, type Snapshot } from './atomic-acceptance'

const bytes = (n: number) => new Uint8Array([n])
class TestStore implements AtomicAcceptanceStore {
  snapshot: Snapshot = { revision: 0, mls: bytes(0), app: bytes(0), history: bytes(0), effects: bytes(0) }
  ledger = new Map<string, string>()
  covered = new Set<AcceptanceStoreName>(ACCEPTANCE_STORES)
  failure = ''
  async transaction<T>(stores: readonly AcceptanceStoreName[], run: (tx: AtomicTransaction) => Promise<T>): Promise<T> {
    if (stores.some(name => !this.covered.has(name))) throw Error('Store not covered')
    let next = structuredClone(this.snapshot)
    const ledger = new Map(this.ledger)
    const tx: AtomicTransaction = {
      readSnapshot: async () => structuredClone(next),
      find: async id => ledger.get(id),
      write: async (record: AcceptanceRecord, revision: number) => {
        if (next.revision !== revision) throw Error('Stale revision')
        for (const name of ['mls', 'app', 'history', 'effects'] as const) {
          next[name] = record[name]
          if (this.failure === name) throw Error(name)
        }
        ledger.set(record.id, record.digest)
        if (this.failure === 'ledger') throw Error('ledger')
        next.revision++
      },
    }
    const result = await run(tx)
    if (this.failure === 'before-commit') throw Error('before-commit')
    this.snapshot = next
    this.ledger = ledger
    if (this.failure === 'after-commit') throw Error('after-commit')
    return result
  }
}
const stage = vi.fn((s: Snapshot) => ({ mls: bytes(s.mls[0] + 1), app: bytes(s.app[0] + 1), history: bytes(s.history[0] + 1), effects: bytes(s.effects[0] + 1) }))

describe('atomic acceptance contract', () => {
  it.each(['mls', 'app', 'history', 'effects', 'ledger', 'before-commit', 'after-commit'])('recovers after %s failure without applying twice', async failure => {
    const store = new TestStore(), ack = vi.fn()
    stage.mockClear()
    store.failure = failure
    await expect(acceptAtomically(store, 'id', 'digest', stage, ack)).rejects.toThrow(failure)
    expect(ack).not.toHaveBeenCalled()
    const committed = failure === 'after-commit'
    expect(store.snapshot.revision).toBe(committed ? 1 : 0)
    store.failure = ''
    expect(await acceptAtomically(store, 'id', 'digest', stage, ack)).toBe(committed ? 'duplicate' : 'accepted')
    expect(store.snapshot).toEqual({ revision: 1, mls: bytes(1), app: bytes(1), history: bytes(1), effects: bytes(1) })
    expect(stage).toHaveBeenCalledTimes(committed ? 1 : 2)
    expect(ack).toHaveBeenCalledOnce()
  })
  it.each(ACCEPTANCE_STORES)('fails closed when %s is outside the transaction', async missing => {
    const store = new TestStore(), ack = vi.fn()
    store.covered.delete(missing)
    await expect(acceptAtomically(store, 'id', 'digest', stage, ack)).rejects.toThrow('not covered')
    expect(ack).not.toHaveBeenCalled()
    expect(store.snapshot.revision).toBe(0)
  })
  it('rejects a reused ID with a different digest', async () => {
    const store = new TestStore(), ack = vi.fn()
    await acceptAtomically(store, 'id', 'one', stage, ack)
    await expect(acceptAtomically(store, 'id', 'two', stage, ack)).rejects.toThrow('mismatch')
    expect(ack).toHaveBeenCalledOnce()
    expect(store.snapshot.revision).toBe(1)
  })
  it('retries a lost acknowledgement without staging again', async () => {
    const store = new TestStore(), ack = vi.fn(() => { throw Error('ack lost') })
    stage.mockClear()
    await expect(acceptAtomically(store, 'id', 'digest', stage, ack)).rejects.toThrow('ack lost')
    await expect(acceptAtomically(store, 'id', 'digest', stage, () => {})).resolves.toBe('duplicate')
    expect(stage).toHaveBeenCalledOnce()
  })
})

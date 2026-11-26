/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CoreClient, PendingClient, initSync } from '../pkg/chat_core.js'
import { makeIdentity, randomId } from '../ids'
import { DeliveryFence, MAX_REPLAY_ENTRIES, type AtomicStore, type Snapshot } from './fence'

const binding = { account: 'bob', session: 'session-1' }

beforeAll(() => initSync({ module: readFileSync(new URL('../pkg/chat_core_bg.wasm', import.meta.url)) }))

class Store implements AtomicStore {
  value: Snapshot
  calls = 0
  failAt = 0
  commitBeforeFailure = false
  constructor(core: Uint8Array) { this.value = { binding, revision: 0, core, seen: [] } }
  async read() { return structuredClone(this.value) }
  async compareAndReplace(revision: number, value: Snapshot) {
    this.calls++
    if (this.value.revision !== revision) return false
    if (this.calls !== this.failAt || this.commitBeforeFailure) this.value = structuredClone(value)
    if (this.calls === this.failAt) throw new Error('uncertain write')
    return true
  }
}
function setup() {
  const alice = new PendingClient().intoClient(makeIdentity('11'.repeat(16), '22'.repeat(16)))
  const bob = new PendingClient().intoClient(makeIdentity('33'.repeat(16), '44'.repeat(16)))
  const started = alice.startConversation([makeIdentity('33'.repeat(16), '44'.repeat(16))], bob.keyPackages(1), randomId())
  bob.receive(started.welcome)
  const store = new Store(bob.snapshot())
  const envelope = alice.sendText(started.conversationId, 'first', 1, randomId())
  const next = () => alice.sendText(started.conversationId, 'second', 2, randomId())
  const open = () => DeliveryFence.open(store, binding, CoreClient.restore)
  return { store, envelope, next, open }
}

describe('isolated delivery fence with MLS', () => {
  it('commits MLS state before acknowledgement and deduplicates after reload', async () => {
    const { store, envelope, next, open } = setup()
    const fence = await open()
    const ack = vi.fn()
    const effect = vi.fn(async (event: ReturnType<CoreClient['receive']>) => { expect(event.text).toBe('first') })
    await fence.deliver('one', envelope, effect, ack)
    await (await open()).deliver('one', envelope, effect, ack)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledTimes(2)
    expect(CoreClient.restore(store.value.core).receive(next()).text).toBe('second')
  })

  it('blocks transport and a second delivery while an effect waits', async () => {
    const { envelope, open } = setup()
    const fence = await open()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const delivery = fence.deliver('one', envelope, async () => { entered(); await wait }, () => {})
    await started
    expect(() => fence.assertTransportAllowed()).toThrow('fenced')
    await expect(fence.deliver('two', envelope, async () => {}, () => {})).rejects.toThrow('fenced')
    release()
    await delivery
    expect(() => fence.assertTransportAllowed()).not.toThrow()
  })

  it('rejects a stale instance before it can apply effects or acknowledge', async () => {
    const { envelope, next, open, store } = setup()
    const first = await open()
    const second = await open()
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const delivery = first.deliver('one', envelope, async () => { entered(); await waiting }, () => {})
    await started
    expect(store.value.pending).toBe('one')
    const effect = vi.fn(async () => {})
    const ack = vi.fn()
    await expect(second.deliver('two', next(), effect, ack)).rejects.toThrow('Stale delivery instance')
    expect(effect).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
    release()
    await delivery
    expect(store.value.seen.map(entry => entry.id)).toEqual(['one'])
  })

  it('rejects the same ID with a different envelope', async () => {
    const { envelope, next, open } = setup()
    const fence = await open()
    await fence.deliver('same', envelope, async () => {}, () => {})
    const effect = vi.fn(async () => {})
    const ack = vi.fn()
    await expect(fence.deliver('same', next(), effect, ack)).rejects.toThrow('envelope mismatch')
    expect(effect).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
  })

  it('poisons the instance if acknowledgement throws after durable acceptance', async () => {
    const { envelope, open, store } = setup()
    const fence = await open()
    const effect = vi.fn(async () => {})
    await expect(fence.deliver('one', envelope, effect, () => { throw new Error('ack failed') })).rejects.toThrow('ack failed')
    expect(store.value.seen.map(entry => entry.id)).toEqual(['one'])
    expect(() => fence.assertTransportAllowed()).toThrow('fenced')
    const ack = vi.fn()
    await (await open()).deliver('one', envelope, effect, ack)
    expect(effect).toHaveBeenCalledOnce()
    expect(ack).toHaveBeenCalledOnce()
  })

  it('rejects a different account or session binding', async () => {
    const { store } = setup()
    await expect(DeliveryFence.open(store, { ...binding, account: 'other' }, CoreClient.restore)).rejects.toThrow('binding mismatch')
    await expect(DeliveryFence.open(store, { ...binding, session: 'other' }, CoreClient.restore)).rejects.toThrow('binding mismatch')
  })

  it('fails closed when the replay ledger is full', async () => {
    const { store, envelope, open } = setup()
    store.value.seen = Array.from({ length: MAX_REPLAY_ENTRIES }, (_, i) => ({ id: String(i), digest: 'digest' }))
    const ack = vi.fn()
    const effect = vi.fn(async () => {})
    await expect((await open()).deliver('new', envelope, effect, ack)).rejects.toThrow('ledger full')
    expect(effect).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
  })

  it('fences partial effects, acknowledgement, future transport, and reload', async () => {
    const { store, envelope, open } = setup()
    const fence = await open()
    const ack = vi.fn()
    const partial: string[] = []
    await expect(fence.deliver('one', envelope, async () => { partial.push('written'); throw new Error('partial') }, ack)).rejects.toThrow('partial')
    expect(partial).toEqual(['written'])
    expect(ack).not.toHaveBeenCalled()
    expect(() => fence.assertTransportAllowed()).toThrow('fenced')
    await expect(open()).rejects.toThrow('manual recovery')
    expect(store.value.pending).toBe('one')
  })

  it.each([[1, false], [1, true], [2, false], [2, true]] as const)(
    'fails closed on uncertain write %i with committed=%s', async (failure, committed) => {
      const { store, envelope, open } = setup()
      const fence = await open()
      store.failAt = failure
      store.commitBeforeFailure = committed
      const ack = vi.fn()
      const effect = vi.fn(async () => {})
      await expect(fence.deliver('one', envelope, effect, ack)).rejects.toThrow('uncertain write')
      expect(ack).not.toHaveBeenCalled()
      expect(() => fence.assertTransportAllowed()).toThrow('fenced')
      if ((failure === 1 && committed) || (failure === 2 && !committed)) {
        await expect(open()).rejects.toThrow('manual recovery')
      } else {
        const reopened = await open()
        await reopened.deliver('one', envelope, effect, ack)
        expect(ack).toHaveBeenCalledTimes(1)
        expect(effect).toHaveBeenCalledTimes(1)
      }
    },
  )
})

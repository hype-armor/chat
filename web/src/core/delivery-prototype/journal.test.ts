/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CoreClient, PendingClient, initSync } from '../pkg/chat_core.js'
import { makeIdentity, randomId } from '../ids'
import { AcceptanceJournal, type JournalState, type JournalStore } from './journal'
import { MAX_REPLAY_ENTRIES } from './fence'

const binding = { account: 'bob', session: 'one' }
type App = { messages: string[]; receipts: string[] }
type Publication = string
class Store implements JournalStore<App, Publication> {
  calls = 0
  failure = 0
  commitFirst = false
  constructor(public value: JournalState<App, Publication>) {}
  async read() { return structuredClone(this.value) }
  async compareAndReplace(revision: number, next: JournalState<App, Publication>) {
    this.calls++
    if (revision !== this.value.revision) return false
    if (this.calls !== this.failure || this.commitFirst) this.value = structuredClone(next)
    if (this.calls === this.failure) throw new Error('uncertain')
    return true
  }
}
beforeAll(() => initSync({ module: readFileSync(new URL('../pkg/chat_core_bg.wasm', import.meta.url)) }))
function setup() {
  const alice = new PendingClient().intoClient(makeIdentity('11'.repeat(16), '22'.repeat(16)))
  const bob = new PendingClient().intoClient(makeIdentity('33'.repeat(16), '44'.repeat(16)))
  const started = alice.startConversation([makeIdentity('33'.repeat(16), '44'.repeat(16))], bob.keyPackages(1), randomId())
  bob.receive(started.welcome)
  const store = new Store({ binding, revision: 0, core: bob.snapshot(), app: { messages: [], receipts: [] }, seen: [] })
  const first = alice.sendText(started.conversationId, 'first', 1, randomId())
  const second = alice.sendText(started.conversationId, 'second', 2, randomId())
  let active = true
  const open = () => AcceptanceJournal.open(store, binding, CoreClient.restore, () => active)
  const stage = (event: ReturnType<CoreClient['receive']>, app: App) => ({ app: { messages: [...app.messages, event.text!], receipts: [...app.receipts, event.text!] }, publications: ['view'] })
  return { store, first, second, open, stage, stop: () => { active = false } }
}
describe('isolated staged acceptance', () => {
  it('commits real MLS and application effects before publication; duplicates do not repeat them', async () => {
    const { store, first, second, open, stage } = setup()
    const publish = vi.fn(async () => { expect(store.value.app).toEqual({ messages: ['first'], receipts: ['first'] }); expect(store.value.pending?.id).toBe('a') })
    const ack = vi.fn()
    await (await open()).deliver('a', first, stage, publish, ack)
    await (await open()).deliver('a', first, stage, publish, ack)
    expect(publish).toHaveBeenCalledOnce(); expect(ack).toHaveBeenCalledTimes(2)
    expect(CoreClient.restore(store.value.core).receive(second).text).toBe('second')
  })
  it('keeps a failed publication fenced across reload', async () => {
    const { store, first, open, stage } = setup()
    const ack = vi.fn()
    await expect((await open()).deliver('a', first, stage, async () => { throw Error('partial') }, ack)).rejects.toThrow('partial')
    expect(store.value.app.messages).toEqual(['first']); expect(ack).not.toHaveBeenCalled()
    await expect(open()).rejects.toThrow('manual recovery')
  })
  it.each([[1, false], [1, true], [2, false], [2, true]] as const)('fences uncertain write %i committed=%s', async (failure, committed) => {
    const { store, first, open, stage } = setup()
    const journal = await open(); store.failure = failure; store.commitFirst = committed
    const ack = vi.fn(); const publish = vi.fn(async () => {})
    await expect(journal.deliver('a', first, stage, publish, ack)).rejects.toThrow('uncertain')
    expect(ack).not.toHaveBeenCalled(); expect(() => journal.assertTransportAllowed()).toThrow('fenced')
    if ((failure === 1 && committed) || (failure === 2 && !committed)) await expect(open()).rejects.toThrow('manual recovery')
    else { store.failure = 0; await (await open()).deliver('a', first, stage, publish, ack); expect(publish).toHaveBeenCalledTimes(1) }
  })
  it('rejects stale instances and changed envelopes', async () => {
    const { first, second, open, stage } = setup()
    const a = await open(), b = await open(), publish = vi.fn(async () => {}), ack = vi.fn()
    await a.deliver('a', first, stage, publish, ack)
    await expect(b.deliver('b', second, stage, publish, ack)).rejects.toThrow('Stale')
    await expect((await open()).deliver('a', second, stage, publish, ack)).rejects.toThrow('mismatch')
    expect(publish).toHaveBeenCalledOnce(); expect(ack).toHaveBeenCalledOnce()
  })
  it('handles reordered MLS envelopes and preserves both acceptance records', async () => {
    const { store, first, second, open, stage } = setup()
    const journal = await open()
    await journal.deliver('b', second, stage, async () => {}, () => {})
    await journal.deliver('a', first, stage, async () => {}, () => {})
    expect(store.value.app.messages).toEqual(['second', 'first'])
    expect(store.value.seen.map(entry => entry.id)).toEqual(['b', 'a'])
  })
  it('fails closed at the replay limit without dropping an ID', async () => {
    const { store, first, open, stage } = setup()
    store.value.seen = Array.from({ length: MAX_REPLAY_ENTRIES }, (_, i) => ({ id: String(i), digest: 'x' }))
    const ack = vi.fn()
    await expect((await open()).deliver('new', first, stage, async () => {}, ack)).rejects.toThrow('ledger full')
    expect(store.value.seen).toHaveLength(MAX_REPLAY_ENTRIES); expect(ack).not.toHaveBeenCalled()
  })
  it('stops publication and acknowledgement when lifecycle ends', async () => {
    const { first, open, stage, stop } = setup()
    const journal = await open(), ack = vi.fn()
    await expect(journal.deliver('a', first, stage, async () => { stop() }, ack)).rejects.toThrow('lifecycle ended')
    expect(ack).not.toHaveBeenCalled(); expect(() => journal.assertTransportAllowed()).toThrow('fenced')
  })
})

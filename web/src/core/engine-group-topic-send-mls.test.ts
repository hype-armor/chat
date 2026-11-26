/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'
import { Engine } from './engine'
import { fromBase64 } from './api'
import { makeIdentity, randomId, toHex } from './ids'

beforeAll(() => initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) }))
const a = '11'.repeat(16), ad = '22'.repeat(16), b = '33'.repeat(16), bd = '44'.repeat(16), c = '55'.repeat(16), cd = '66'.repeat(16)
type Batch = readonly (readonly [string, Uint8Array])[]
function pair() {
  const alice = new PendingClient().intoClient(makeIdentity(a, ad))
  const bob = new PendingClient().intoClient(makeIdentity(b, bd))
  const charlie = new PendingClient().intoClient(makeIdentity(c, cd))
  const started = alice.startConversation([makeIdentity(b, bd), makeIdentity(c, cd)], [...bob.keyPackages(1), ...charlie.keyPackages(1)], randomId())
  bob.receive(started.welcome)
  charlie.receive(started.welcome)
  const id = toHex(started.conversationId)
  function worker(core: CoreClient, account: string, device: string, enabled = true) {
    const events: unknown[] = []
    const engine = new Engine((e) => events.push(e), { groupTopics: enabled })
    const values = new Map<string, unknown>()
    const batches: Batch[] = []
    const store = {
      putBatch: vi.fn(async (entries: Batch) => {
        batches.push(entries)
        for (const [key, bytes] of entries) values.set(key, key === 'app' ? JSON.parse(new TextDecoder().decode(bytes)) : bytes.slice())
      }),
      getJson: vi.fn(async (key: string) => structuredClone(values.get(key))),
      putJson: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }),
    }
    engine['account'] = { accountId: account, deviceId: device, username: account, displayName: account, token: '' }
    engine['core'] = core
    engine['connection'] = 'online'
    engine['store'] = store as unknown as Engine['store']
    engine['state'].conversations[id] = { id, peers: [account === a ? b : a, c], name: 'Private group', admins: [a], lastAt: 1 }
    const send = vi.fn(), close = vi.fn()
    engine['ws'] = { send, close } as unknown as Engine['ws']
    // Most tests start after catch-up. Barrier tests explicitly clear readiness.
    engine['topicReady'] = { socket: engine['ws']!, epoch: engine['draftEpoch'], accountId: account }
    const deliver = async (envelope: Uint8Array) => engine['onDeliver']({ envelope, conversationId: started.conversationId, messageId: randomId(), welcome: false } as Parameters<Engine['onDeliver']>[0])
    const summary = () => { const view = engine.view(); return view.phase === 'ready' ? view.conversations[0] : undefined }
    return { engine, values, store, batches, send, close, deliver, events, summary }
  }
  return { alice, bob, charlie, id, bytes: started.conversationId, worker }
}
function barrier() {
  let release!: () => void
  const wait = new Promise<void>((r) => { release = r })
  return { wait, release }
}

describe('opt-in worker topic sends with real MLS', () => {
  it('waits for matching Pong and durable backlog processing before authoring', async () => {
    const { alice, bob, bytes, id, worker } = pair()
    const w = worker(bob, b, bd)
    w.engine['topicReady'] = undefined
    const pong = barrier(), entered = barrier(), durable = barrier()
    w.engine['request'] = vi.fn(async () => {
      await pong.wait
      return { kind: 'pong' } as Awaited<ReturnType<Engine['request']>>
    })
    const socket = w.engine['ws']
    const catchup = w.engine['finishTopicCatchup'](() => w.engine['ws'] === socket)
    w.store.putBatch.mockImplementationOnce(async () => { entered.release(); await durable.wait })
    const delivery = w.deliver(alice.sendGroupTopic(bytes, 'Backlog', 7, 1, randomId()))
    await entered.wait
    pong.release()
    await Promise.resolve()
    expect(w.engine['groupTopicAllowed'](id)).toBe(false)
    expect(w.summary()?.topic).toBeUndefined()
    durable.release()
    await delivery
    await catchup
    expect(w.summary()?.topic).toBe('Backlog')
    expect(w.engine['groupTopicAllowed'](id)).toBe(true)
    w.engine['request'] = vi.fn(async () => undefined)
    await w.engine.setGroupTopic(id, 'After backlog')
    expect(w.engine['state'].outbox[0].groupTopic?.candidate.clock).toBe(8)
  })

  it('requires successful auth initialization and pending-commit reconciliation before readiness', async () => {
    const { alice, id, worker } = pair()
    const w = worker(alice, a, ad)
    w.engine['topicReady'] = undefined
    w.engine['request'] = vi.fn(async () => ({ kind: 'pong' }) as Awaited<ReturnType<Engine['request']>>)
    const initialized = barrier()
    const catchup = w.engine['finishTopicCatchup'](() => true, initialized.wait)
    await Promise.resolve()
    expect(w.engine['groupTopicAllowed'](id)).toBe(false)
    initialized.release()
    await catchup
    expect(w.engine['groupTopicAllowed'](id)).toBe(true)
    w.engine['topicReady'] = undefined
    await expect(w.engine['finishTopicCatchup'](() => true, Promise.reject(new Error('auth storage failed')))).rejects.toThrow('auth storage failed')
    expect(w.engine['topicReady']).toBeUndefined()
    w.engine['state'].pendingCommit = { conversationId: 'ff'.repeat(16), commitHash: '' }
    await w.engine['finishTopicCatchup'](() => true)
    expect(w.engine['topicReady']).toBeUndefined()
    expect(w.engine['groupTopicAllowed'](id)).toBe(false)
  })

  it('ignores an unmatched Pong until the same-socket request receives its own reply', async () => {
    const { alice, id, worker } = pair()
    const w = worker(alice, a, ad)
    w.engine['topicReady'] = undefined
    Object.assign(w.engine['ws']!, { readyState: WebSocket.OPEN })
    const catchup = w.engine['finishTopicCatchup'](() => true)
    const requestId = [...w.engine['waiters'].keys()][0]
    const pong = (id: number) => ({ kind: 'pong', requestId: id }) as Parameters<Engine['onFrame']>[0]
    w.engine['onFrame'](pong(requestId + 1))
    await Promise.resolve()
    expect(w.engine['topicReady']).toBeUndefined()
    expect(w.engine['waiters'].has(requestId)).toBe(true)
    w.engine['onFrame'](pong(requestId))
    await catchup
    expect(w.engine['groupTopicAllowed'](id)).toBe(true)
    expect(w.engine['waiters'].size).toBe(0)
  })

  it('rejects absent or non-Pong replies and stale socket, account or epoch barriers', async () => {
    for (const change of ['missing', 'error', 'socket', 'epoch', 'account', 'fenced', 'ended']) {
      const { alice, id, worker } = pair()
      const w = worker(alice, a, ad)
      w.engine['topicReady'] = undefined
      const reply = barrier()
      w.engine['request'] = vi.fn(async () => {
        await reply.wait
        return (change === 'missing' ? undefined : { kind: change === 'error' ? 'error' : 'pong' }) as Awaited<ReturnType<Engine['request']>>
      })
      const socket = w.engine['ws']
      const catchup = w.engine['finishTopicCatchup'](() => w.engine['ws'] === socket)
      if (change === 'socket') w.engine['ws'] = { send: vi.fn(), close: vi.fn() } as unknown as Engine['ws']
      if (change === 'epoch') w.engine['draftEpoch']++
      if (change === 'account') w.engine['account'] = { ...w.engine['account']!, accountId: b }
      if (change === 'fenced') w.engine['deliveryFenced'] = true
      if (change === 'ended') w.engine['endingSession'] = true
      reply.release()
      if (change === 'fenced') await expect(catchup).rejects.toThrow('Delivery failed')
      else await catchup
      expect(w.engine['topicReady']).toBeUndefined()
      expect(w.engine['groupTopicAllowed'](id)).toBe(false)
    }
  })

  it('persists encrypted updates and clear with their clock; restores state without making chat history', async () => {
    const { alice, bob, id, worker } = pair()
    const aw = worker(alice, a, ad), bw = worker(bob, b, bd)
    expect(aw.summary()).not.toHaveProperty('topic')
    await aw.engine.setGroupTopic(id, 'Private topic')
    const item = aw.engine['state'].outbox[0]
    expect(item).toMatchObject({ silent: true, conversationId: id, recipients: [bd, cd] })
    expect(new TextDecoder().decode(fromBase64(item.envelope))).not.toContain('Private topic')
    expect(aw.batches[0].map(([k]) => k)).toEqual(['core', 'app'])
    expect((aw.values.get('app') as Engine['state']).outbox).toEqual([item])
    expect(aw.summary()?.topic).toBeUndefined()
    aw.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true }) as Awaited<ReturnType<Engine['request']>>)
    await aw.engine['flushOutbox']()
    expect(aw.summary()?.topic).toBe('Private topic')
    await bw.deliver(fromBase64(item.envelope))
    expect(bw.summary()?.topic).toBe('Private topic')
    expect(bw.engine['state'].conversations[id]).toMatchObject({ lastAt: 1 })
    expect(bw.engine['state'].conversations[id].unread).toBeUndefined()
    expect(bw.engine['receipts'].size).toBe(0)
    expect(bw.values.has('messages:' + id)).toBe(false)
    await bw.engine.setGroupTopic(id, '')
    await aw.deliver(fromBase64(bw.engine['state'].outbox[0].envelope))
    expect(aw.summary()?.topic).toBe('')
    expect(aw.engine['state'].groupTopics?.[id].clock).toBe(2)
    const restored = worker(CoreClient.restore(aw.values.get('core') as Uint8Array), a, ad)
    restored.engine['state'] = structuredClone(aw.values.get('app')) as Engine['state']
    expect(restored.summary()?.topic).toBe('')
    const reply = barrier()
    restored.engine['request'] = vi.fn(async () => {
      await reply.wait
      return { kind: 'send_result', accepted: true } as Awaited<ReturnType<Engine['request']>>
    })
    await restored.engine.setGroupTopic(id, 'After restart')
    expect(restored.engine['state'].outbox[0].groupTopic?.candidate.clock).toBe(3)
    expect(restored.summary()?.topic).toBe('')
    reply.release()
    await vi.waitFor(() => expect(restored.summary()?.topic).toBe('After restart'))
  })

  it('never publishes or transports an edit before acceptance, even during another flush', async () => {
    const { alice, id, worker } = pair()
    const w = worker(alice, a, ad)
    const entered = barrier(), finish = barrier()
    w.store.putBatch.mockImplementationOnce(async () => { entered.release(); await finish.wait })
    const accept = w.engine.setGroupTopic(id, 'Not durable yet')
    await entered.wait
    w.engine['connection'] = 'online'
    const request = vi.fn(async () => undefined)
    w.engine['request'] = request
    await w.engine['flushOutbox']()
    expect(request).not.toHaveBeenCalled()
    expect(w.summary()?.topic).toBeUndefined()
    expect(w.events).toEqual([])
    finish.release()
    await accept
    expect(request).toHaveBeenCalledTimes(1)
    expect(w.summary()?.topic).toBeUndefined()
  })

  it('fences persistence failures, leaves no accepted app state and blocks all later transport', async () => {
    const { alice, id, worker } = pair()
    const w = worker(alice, a, ad)
    const before = alice.snapshot()
    w.store.putBatch.mockRejectedValueOnce(new Error('disk failed'))
    const request = vi.fn(async () => undefined)
    w.engine['request'] = request
    w.engine['connection'] = 'online'
    await expect(w.engine.setGroupTopic(id, 'Rejected')).rejects.toThrow('disk failed')
    expect(w.values.has('app')).toBe(false)
    expect(w.engine['state'].groupTopics?.[id]).toBeUndefined()
    expect(w.engine['state'].outbox).toEqual([])
    expect(w.summary()?.topic).toBeUndefined()
    expect(w.engine['core']!.snapshot()).not.toEqual(before)
    expect(w.close).toHaveBeenCalledOnce()
    await w.engine['flushOutbox']()
    expect(request).not.toHaveBeenCalled()
    await expect(w.engine.setGroupTopic(id, 'Later')).rejects.toThrow('Delivery failed')
  })

  it('hides received state and delays acknowledgement until the atomic batch succeeds', async () => {
    const { alice, bob, bytes, worker } = pair()
    const w = worker(bob, b, bd)
    const entered = barrier(), finish = barrier()
    w.store.putBatch.mockImplementationOnce(async () => { entered.release(); await finish.wait })
    const receive = w.deliver(alice.sendGroupTopic(bytes, 'Incoming', 1, 1, randomId()))
    await entered.wait
    expect(w.summary()?.topic).toBeUndefined()
    expect(w.send).not.toHaveBeenCalled()
    finish.release()
    await receive
    expect(w.summary()?.topic).toBe('Incoming')
    expect(w.send).toHaveBeenCalledOnce()
  })

  it('fences an opt-in receive storage failure without publishing topic state or acknowledging', async () => {
    const { alice, bob, bytes, worker } = pair()
    const w = worker(bob, b, bd)
    w.store.putBatch.mockRejectedValueOnce(new Error('receive disk failed'))
    const envelope = alice.sendGroupTopic(bytes, 'Not accepted incoming', 1, 1, randomId())
    await expect(w.deliver(envelope)).rejects.toThrow('receive disk failed')
    expect(w.summary()).not.toHaveProperty('topic')
    expect(w.events).toEqual([])
    expect(w.send).not.toHaveBeenCalled()
    expect(w.close).toHaveBeenCalledOnce()
    expect(w.values.has('app')).toBe(false)
    expect(w.engine['deliveryFenced']).toBe(true)
  })

  it('does not send after session loss while the acceptance batch is pending', async () => {
    const { alice, id, worker } = pair()
    const w = worker(alice, a, ad)
    const entered = barrier(), finish = barrier()
    w.store.putBatch.mockImplementationOnce(async () => { entered.release(); await finish.wait })
    const accept = w.engine.setGroupTopic(id, 'Old session')
    await entered.wait
    w.engine['endingSession'] = true
    w.engine['draftEpoch']++
    w.engine['connection'] = 'online'
    const request = vi.fn(async () => undefined)
    w.engine['request'] = request
    finish.release()
    await expect(accept).rejects.toThrow('session ended')
    await w.engine['flushOutbox']()
    expect(request).not.toHaveBeenCalled()
    expect(w.events).toEqual([])
  })

  it('does not expose an old pending topic after a same-group replacement session', async () => {
    const { alice, bob, id, worker } = pair()
    const w = worker(alice, a, ad)
    await w.engine.setGroupTopic(id, 'Previously accepted')
    w.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true }) as Awaited<ReturnType<Engine['request']>>)
    await w.engine['flushOutbox']()
    const entered = barrier(), finish = barrier()
    w.store.putBatch.mockImplementationOnce(async () => { entered.release(); await finish.wait })
    const accept = w.engine.setGroupTopic(id, 'Old pending')
    await entered.wait
    // Model state replacement while the old storage promise is suspended. Real
    // signOut serializes this replacement after the write under exclusive().
    const replacement = worker(bob, b, bd)
    w.engine['draftEpoch']++
    w.engine['account'] = replacement.engine['account']
    w.engine['core'] = bob
    w.engine['state'] = replacement.engine['state']
    expect(w.summary()?.topic).toBeUndefined()
    finish.release()
    await expect(accept).rejects.toThrow('session ended')
    expect(w.summary()?.topic).toBeUndefined()
    expect(w.engine['state'].outbox).toHaveLength(0)
  })

  it('rejects unsupported contexts and invalid text without consuming an outgoing ratchet', async () => {
    const { alice, id, worker } = pair()
    const w = worker(alice, a, ad)
    const conv = w.engine['state'].conversations[id]
    const before = alice.snapshot()
    for (const patch of [{ self: true }, { request: true }, { channelParentId: 'ff'.repeat(16) }, { channelInfoCandidate: { parentId: 'ff'.repeat(16), name: 'Candidate', sender: '' } }, { status: 'left' as const }, { status: 'removed' as const }, { status: 'restoring' as const }]) {
      Object.assign(conv, patch)
      await expect(w.engine.setGroupTopic(id, 'Bad')).rejects.toThrow('unavailable')
      delete conv.self; delete conv.request; delete conv.status; delete conv.channelParentId; delete conv.channelInfoCandidate
    }
    delete conv.name
    conv.peers = [b]
    await expect(w.engine.setGroupTopic(id, 'Direct')).rejects.toThrow('unavailable')
    conv.name = 'Private group'
    conv.peers = [b, c]
    await expect(w.engine.setGroupTopic('ff'.repeat(16), 'Unknown')).rejects.toThrow('unavailable')
    await expect(w.engine.setGroupTopic(id, '🦆'.repeat(129))).rejects.toThrow('512')
    w.engine['state'].groupTopics = { [id]: { text: '', clock: Number.MAX_SAFE_INTEGER, account: a, device: ad } }
    await expect(w.engine.setGroupTopic(id, 'Overflow')).rejects.toThrow('clock')
    w.engine['state'].pendingCommit = { conversationId: id, commitHash: '' }
    await expect(w.engine.setGroupTopic(id, 'Pending')).rejects.toThrow('unavailable')
    expect(w.batches).toHaveLength(0)
    expect(alice.snapshot()).toEqual(before)
  })

  it('ignores topics before a three-account Welcome is classified and cancels a topic on a paused child', async () => {
    const { alice, bob, bytes, id, worker } = pair()
    const recipient = worker(bob, b, bd)
    const conv = recipient.engine['state'].conversations[id]
    delete conv.name
    delete conv.admins
    await expect(recipient.engine.setGroupTopic(id, 'Unknown group')).rejects.toThrow('unavailable')
    await recipient.deliver(alice.sendGroupTopic(bytes, 'Before classification', 1, 1, randomId()))
    expect(recipient.engine['state'].groupTopics?.[id]).toBeUndefined()
    expect(recipient.summary()?.topic).toBeUndefined()

    const author = worker(alice, a, ad)
    await author.engine.setGroupTopic(id, 'Queued before classification')
    author.engine['state'].conversations[id].channelParentId = 'ff'.repeat(16)
    author.engine['state'].groupTopics = { [id]: { text: 'Hidden', clock: 1, account: a, device: ad } }
    const request = vi.fn(async () => undefined)
    author.engine['request'] = request
    await author.engine['flushOutbox']()
    expect(author.engine['state'].outbox).toHaveLength(0)
    expect(author.engine['groupTopicSummary'](id)).toEqual({})
    expect(request).not.toHaveBeenCalled()
  })

  it('off→on→off restart never exposes or transmits an opted-in queued topic', async () => {
    const { alice, bob, bytes, id, worker } = pair()
    const off = worker(alice, a, ad, false)
    await expect(off.engine.setGroupTopic(id, 'Off')).rejects.toThrow('unavailable')
    const on = worker(alice, a, ad)
    await on.engine.setGroupTopic(id, 'Opted in')
    const restarted = worker(CoreClient.restore(on.values.get('core') as Uint8Array), a, ad, false)
    restarted.engine['state'] = structuredClone(on.values.get('app')) as Engine['state']
    expect(restarted.summary()).not.toHaveProperty('topic')
    expect(restarted.summary()).not.toHaveProperty('canEditTopic')
    restarted.engine['connection'] = 'online'
    const request = vi.fn(async () => undefined)
    restarted.engine['request'] = request
    await restarted.engine['flushOutbox']()
    expect(request).not.toHaveBeenCalled()
    expect(restarted.engine['state'].outbox).toHaveLength(0)
    bob.receive(fromBase64(on.engine['state'].outbox[0].envelope))
    expect(bob.receive(restarted.engine['core']!.sendText(bytes, 'After skipped topic', 2, randomId())).text).toBe('After skipped topic')
  })

  it('cancels stale queued recipients and same-roster epoch changes instead of rebroadcasting', async () => {
    const { alice, bob, bytes, id, worker } = pair()
    const w = worker(bob, b, bd)
    await w.engine.setGroupTopic(id, 'Before epoch')
    const changed = alice.commitProposals(bytes, randomId())
    alice.confirmCommit(bytes)
    await w.engine['apply'](bob.receive(changed.commit), toHex(randomId()))
    w.engine['connection'] = 'online'
    const request = vi.fn(async () => undefined)
    w.engine['request'] = request
    await w.engine['flushOutbox']()
    expect(request).not.toHaveBeenCalled()
    expect(w.engine['state'].outbox).toHaveLength(0)
    expect(w.summary()?.topic).toBeUndefined()
    expect(w.engine['state'].alerts[0].text).toContain('Could not confirm')
  })

  it('bounds skipped topic generations across disabled restarts and forbids offline or overlapping authoring', async () => {
    const { alice, id, worker } = pair()
    const w = worker(alice, a, ad)
    w.engine['connection'] = 'offline'
    await expect(w.engine.setGroupTopic(id, 'Offline')).rejects.toThrow('unavailable')
    w.engine['connection'] = 'online'
    await w.engine.setGroupTopic(id, 'Pending')
    await expect(w.engine.setGroupTopic(id, 'Overlap')).rejects.toThrow('unavailable')
    const off = worker(CoreClient.restore(w.values.get('core') as Uint8Array), a, ad, false)
    off.engine['state'] = structuredClone(w.values.get('app')) as Engine['state']
    await off.engine['flushOutbox']()
    expect(off.engine['state'].groupTopicSends?.[id]).toBe(1)
    const reenabled = worker(CoreClient.restore(off.values.get('core') as Uint8Array), a, ad)
    reenabled.engine['state'] = structuredClone(off.values.get('app')) as Engine['state']
    reenabled.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true }) as Awaited<ReturnType<Engine['request']>>)
    for (let n = 1; n < 32; n++) {
      await reenabled.engine.setGroupTopic(id, 'Budget ' + n)
      await reenabled.engine['flushOutbox']()
    }
    expect(reenabled.engine['state'].groupTopicSends?.[id]).toBe(32)
    await expect(reenabled.engine.setGroupTopic(id, 'Over budget')).rejects.toThrow('unavailable')
  })

  it('rejects a GroupInfo-promoted direct conversation with multiple devices from only 2 accounts', async () => {
    const { worker } = pair()
    const alice = new PendingClient().intoClient(makeIdentity(a, ad))
    const bob = new PendingClient().intoClient(makeIdentity(b, bd))
    const otherBob = new PendingClient().intoClient(makeIdentity(b, cd))
    const started = alice.startConversation([makeIdentity(b, bd), makeIdentity(b, cd)], [...bob.keyPackages(1), ...otherBob.keyPackages(1)], randomId())
    bob.receive(started.welcome)
    const id = toHex(started.conversationId)
    const w = worker(bob, b, bd)
    w.engine['state'].conversations[id] = { id, peers: [a], name: 'Pretend group', admins: [a], lastAt: 1 }
    await expect(w.engine.setGroupTopic(id, 'Not a proven group')).rejects.toThrow('unavailable')
    await w.engine['onDeliver']({ envelope: alice.sendGroupTopic(started.conversationId, 'Rejected incoming', 1, 1, randomId()), conversationId: started.conversationId, messageId: randomId(), welcome: false } as Parameters<Engine['onDeliver']>[0])
    expect(w.engine['state'].groupTopics?.[id]).toBeUndefined()
  })

  it('does not replay a transiently queued topic on a replacement socket', async () => {
    const { alice, id, worker } = pair()
    const w = worker(alice, a, ad)
    const request = vi.fn(async () => undefined)
    w.engine['request'] = request
    await w.engine.setGroupTopic(id, 'Old connection')
    expect(request).toHaveBeenCalledOnce()
    w.engine['ws'] = { send: vi.fn(), close: vi.fn() } as unknown as Engine['ws']
    await w.engine['flushOutbox']()
    expect(request).toHaveBeenCalledOnce()
    expect(w.engine['state'].outbox).toHaveLength(0)
    expect(w.engine['state'].alerts[0].text).toContain('connection or group changed')
    expect(w.engine['state'].groupTopicSends?.[id]).toBe(1)
  })

  it('receives still-authorized topics while a departure proposal is pending, but refuses authoring', async () => {
    const { alice, bob, charlie, bytes, id, worker } = pair()
    const w = worker(bob, b, bd)
    const proposal = charlie.leave(bytes, randomId())
    await w.deliver(proposal)
    // Do not run the designated committer in this isolated receive test.
    expect(bob.hasPendingProposals(bytes)).toBe(true)
    await w.deliver(alice.sendGroupTopic(bytes, 'Still current', 1, 1, randomId()))
    expect(w.summary()?.topic).toBe('Still current')
    await expect(w.engine.setGroupTopic(id, 'Cannot author')).rejects.toThrow('unavailable')
  })

  it('resets the conservative send budget only after an actual authenticated epoch advance', async () => {
    const { alice, bob, bytes, id, worker } = pair()
    const w = worker(bob, b, bd)
    w.engine['state'].groupTopicSends = { [id]: 32 }
    await expect(w.engine.setGroupTopic(id, 'Budget full')).rejects.toThrow('unavailable')
    const changed = alice.commitProposals(bytes, randomId())
    alice.confirmCommit(bytes)
    await w.deliver(changed.commit)
    expect(w.engine['state'].groupTopicSends?.[id]).toBe(0)
    await w.engine.setGroupTopic(id, 'New epoch')
    expect(w.engine['state'].groupTopicSends?.[id]).toBe(1)
  })

  it('blocks topic transport while a local membership commit awaits its server result', async () => {
    const { bob, bytes, id, worker } = pair()
    const w = worker(bob, b, bd)
    await w.engine.setGroupTopic(id, 'Queued before commit')
    const changed = bob.commitProposals(bytes, randomId())
    const entered = barrier(), finish = barrier()
    w.engine['request'] = vi.fn(async () => { entered.release(); await finish.wait; return undefined })
    const commit = w.engine['exclusive'](() => w.engine['sendCommit']({ conversationId: id, commitHash: '' }, changed.commit, [ad, cd]))
    await entered.wait
    expect(w.engine['groupTopicTransportAllowed'](id)).toBe(false)
    const flush = w.engine['flushOutbox']()
    finish.release()
    await commit
    await flush
    expect(w.engine['request']).toHaveBeenCalledOnce()
    expect(w.engine['state'].outbox).toHaveLength(0)
    expect(w.summary()?.topic).toBeUndefined()
    expect(w.engine['state'].alerts[0].text).toContain('Could not confirm')
  })

  it('accepts retained-epoch updates only from an exact current device and persists rejected ratchets', async () => {
    const { alice, bob, charlie, bytes, id, worker } = pair()
    const newcomer = new PendingClient().intoClient(makeIdentity('77'.repeat(16), '88'.repeat(16)))
    const added = alice.addMembers(bytes, [makeIdentity('77'.repeat(16), '88'.repeat(16))], newcomer.keyPackages(1), randomId(), randomId())
    alice.confirmCommit(bytes)
    bob.receive(added.commit)
    charlie.receive(added.commit)
    newcomer.receive(added.welcome)
    const w = worker(bob, b, bd)
    w.engine['state'].conversations[id].peers = [a, c]
    w.engine['queueProfile'] = vi.fn()
    const delayedCurrent = charlie.sendGroupTopic(bytes, 'Current device, past epoch', 1, 1, randomId())
    const delayedRemoved = alice.sendGroupTopic(bytes, 'Removed device', 100, 1, randomId())
    const removed = charlie.removeMembers(bytes, [makeIdentity(a, ad).slice(0, 16)], randomId())
    charlie.confirmCommit(bytes)
    await w.deliver(removed.commit)
    await w.deliver(delayedCurrent)
    expect(w.summary()?.topic).toBe('Current device, past epoch')
    await w.deliver(delayedRemoved)
    expect(w.summary()?.topic).toBe('Current device, past epoch')
    const restored = CoreClient.restore(w.values.get('core') as Uint8Array)
    expect(() => restored.receive(delayedRemoved)).toThrow()
    expect(w.engine['state'].groupTopics?.[id].clock).toBe(1)
    expect(w.send).toHaveBeenCalledTimes(3)
  })

  it('binds topics to the authenticated MLS conversation, not the delivery frame', async () => {
    const { alice, bob, bytes, id, worker } = pair()
    const w = worker(bob, b, bd)
    const other = alice.startConversation([makeIdentity(b, bd)], bob.keyPackages(1), randomId())
    bob.receive(other.welcome)
    const otherId = toHex(other.conversationId)
    w.engine['state'].conversations[otherId] = { id: otherId, peers: [a], name: 'Other group', admins: [a], lastAt: 1 }
    const topic = alice.sendGroupTopic(bytes, 'Only first group', 1, 1, randomId())
    await w.engine['onDeliver']({ envelope: topic, conversationId: other.conversationId, messageId: randomId(), welcome: false } as Parameters<Engine['onDeliver']>[0])
    expect(w.engine['state'].groupTopics?.[id]).toBeUndefined()
    expect(w.engine['state'].groupTopics?.[otherId]).toBeUndefined()
    expect(() => CoreClient.restore(w.values.get('core') as Uint8Array).receive(topic)).toThrow()
    expect(w.send).toHaveBeenCalledOnce()
  })

  it('retains ordered retries and reports a permanent transport rejection without creating chat history', async () => {
    const { alice, id, worker } = pair()
    const w = worker(alice, a, ad)
    await w.engine.setGroupTopic(id, 'Queued')
    const item = w.engine['state'].outbox[0]
    const request = vi.fn(async () => undefined)
    w.engine['request'] = request
    w.engine['connection'] = 'online'
    await w.engine['flushOutbox']()
    expect(w.engine['state'].outbox[0]).toBe(item)
    expect(request).toHaveBeenCalledOnce()
    expect(w.values.has('messages:' + id)).toBe(false)
    w.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: false }) as Awaited<ReturnType<Engine['request']>>)
    await w.engine['flushOutbox']()
    expect(w.engine['state'].outbox).toHaveLength(0)
    expect(w.engine['state'].alerts[0].text).toContain('delivery failed')
    expect(w.summary()?.topic).toBeUndefined()
    expect((w.values.get('app') as Engine['state']).groupTopics?.[id]).toBeUndefined()
    expect(w.values.has('messages:' + id)).toBe(false)
  })

  it('fences an accepted send when settlement persistence fails and hides its uncommitted winner', async () => {
    const { alice, id, worker } = pair()
    const w = worker(alice, a, ad)
    await w.engine.setGroupTopic(id, 'Accepted by relay')
    w.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true }) as Awaited<ReturnType<Engine['request']>>)
    w.store.putBatch.mockRejectedValueOnce(new Error('settlement disk failure'))
    await expect(w.engine['flushOutbox']()).rejects.toThrow('settlement disk failure')
    expect(w.engine['deliveryFenced']).toBe(true)
    expect(w.engine['state'].groupTopics?.[id]).toBeUndefined()
    expect(w.summary()?.topic).toBeUndefined()
    expect(w.close).toHaveBeenCalledOnce()
  })

  it('authenticates concurrent updates, converges and retains the winning clear tombstone', async () => {
    const { alice, bob, id, worker } = pair()
    const aw = worker(alice, a, ad), bw = worker(bob, b, bd)
    await aw.engine.setGroupTopic(id, 'Alice')
    await bw.engine.setGroupTopic(id, 'Bob')
    await aw.deliver(fromBase64(bw.engine['state'].outbox[0].envelope))
    await bw.deliver(fromBase64(aw.engine['state'].outbox[0].envelope))
    for (const w of [aw, bw]) {
      w.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true }) as Awaited<ReturnType<Engine['request']>>)
      await w.engine['flushOutbox']()
    }
    expect(aw.engine['state'].groupTopics).toEqual(bw.engine['state'].groupTopics)
    expect(aw.summary()?.topic).toBe('Bob')
    aw.engine['request'] = vi.fn(async () => undefined)
    await aw.engine.setGroupTopic(id, '')
    await bw.deliver(fromBase64(aw.engine['state'].outbox[0].envelope))
    expect(bw.summary()?.topic).toBe('')
    expect(bw.engine['state'].groupTopics?.[id].clock).toBe(2)
  })
})

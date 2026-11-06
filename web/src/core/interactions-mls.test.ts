/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'
import { makeIdentity, randomId, toHex } from './ids'
import { Engine } from './engine'
import { fromBase64 } from './api'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) })
})

function pair() {
  const aliceIdentity = makeIdentity('11'.repeat(16), '22'.repeat(16))
  const bobIdentity = makeIdentity('33'.repeat(16), '44'.repeat(16))
  const alice = new PendingClient().intoClient(aliceIdentity)
  const bob = new PendingClient().intoClient(bobIdentity)
  const started = alice.startConversation([bobIdentity], bob.keyPackages(1), randomId())
  bob.receive(started.welcome)
  return { alice, bob, conversationId: started.conversationId, aliceIdentity }
}

describe('reply and typing WASM contracts', () => {
  it('carries reply references inside MLS across snapshots and linked-device history', () => {
    const { alice, bob, conversationId, aliceIdentity } = pair()
    const originalId = randomId()
    const original = bob.receive(alice.sendText(conversationId, 'Original', Date.now(), originalId))
    const originalHash = alice.lastSentContentHash
    expect(originalHash?.length).toBe(32)
    expect(original.contentHash).toEqual(originalHash)
    const restored = CoreClient.restore(alice.snapshot())
    const event = bob.receive(restored.sendText(conversationId, 'Reply', Date.now(), randomId(), originalId, originalHash))
    expect(event.replyTo).toEqual(originalId)
    expect(event.replyToHash).toEqual(originalHash)
    expect(event.contentHash).toEqual(restored.lastSentContentHash)
    expect(event.text).toBe('Reply')
    expect(event.sender).toEqual(aliceIdentity)
    const linkedIdentity = makeIdentity('11'.repeat(16), '55'.repeat(16))
    const linked = new PendingClient().intoClient(linkedIdentity)
    const added = restored.addMembers(conversationId, [linkedIdentity], linked.keyPackages(1), randomId(), randomId())
    restored.confirmCommit(conversationId)
    linked.receive(added.welcome)
    bob.receive(added.commit)
    const linkedEvent = linked.receive(restored.sendText(conversationId, 'Reply from the original device', Date.now(), randomId(), originalId, originalHash))
    expect(linkedEvent.replyTo).toEqual(originalId)
    expect(linkedEvent.replyToHash).toEqual(originalHash)
    // The reference survives even if this new device does not have the target yet.
    expect(linkedEvent.sender).toEqual(aliceIdentity)
  })

  it('captures the authenticated outgoing hash in worker history before another send', async () => {
    const { alice, bob, conversationId } = pair()
    const id = toHex(conversationId)
    const engine = new Engine(() => {})
    const values = new Map<string, unknown>()
    engine['core'] = alice
    engine['account'] = { accountId: '11'.repeat(16), deviceId: '22'.repeat(16), username: 'alice', displayName: 'Alice', token: '' }
    engine['state'].conversations[id] = { id, peers: ['33'.repeat(16)], lastAt: 0 }
    engine['store'] = {
      getJson: async (key: string) => values.get(key),
      putJson: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
      putBytes: async (key: string, value: Uint8Array) => { values.set(key, value.slice()) },
    } as unknown as Engine['store']
    engine['flushOutbox'] = vi.fn(async () => {})
    await engine.sendText(id, 'Worker original')
    const stored = values.get(`messages:${id}`) as { id: string; contentHash: string }[]
    const received = bob.receive(fromBase64(engine['state'].outbox[0].envelope))
    expect(stored[0].contentHash).toBe(toHex(received.contentHash!))
    await engine.sendText(id, 'Worker reply', stored[0].id)
    const reply = bob.receive(fromBase64(engine['state'].outbox[1].envelope))
    expect(toHex(reply.replyToHash!)).toBe(stored[0].contentHash)
    expect((await engine.messages(id))[1].reply).toMatchObject({ from: 'me', fromName: 'You', text: 'Worker original' })
  })

  it('retains the ratchet after transient typing and a dropped typing envelope', () => {
    const { alice, bob, conversationId } = pair()
    const now = Date.now()
    const typing = bob.receive(alice.sendTyping(conversationId, true, now, now + 8_000, randomId()))
    expect(typing.typingActive).toBe(true)
    expect(typing.typingExpiresAtMs).toBe(now + 8_000)
    expect(typing.text).toBeUndefined()
    expect(typing.replyTo).toBeUndefined()
    const restored = CoreClient.restore(alice.snapshot())
    // Failed transient delivery is not retried. A skipped generation must remain safe.
    restored.sendTyping(conversationId, false, now + 1, now + 8_001, randomId())
    const afterDrop = CoreClient.restore(restored.snapshot())
    expect(bob.receive(afterDrop.sendText(conversationId, 'After typing', now + 2, randomId())).text).toBe('After typing')
  })
})

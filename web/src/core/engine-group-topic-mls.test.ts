/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'
import { Engine } from './engine'
import { makeIdentity, randomId, toHex } from './ids'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) })
})

function setupTopicDelivery() {
  const alice = new PendingClient().intoClient(makeIdentity('11'.repeat(16), '22'.repeat(16)))
  const bob = new PendingClient().intoClient(makeIdentity('33'.repeat(16), '44'.repeat(16)))
  const started = alice.startConversation([makeIdentity('33'.repeat(16), '44'.repeat(16))], bob.keyPackages(1), randomId())
  bob.receive(started.welcome)
  const id = toHex(started.conversationId)
  const seed = new Engine(() => {})
  seed['state'].conversations[id] = { id, peers: ['11'.repeat(16)], lastAt: 1 }
  const initialCore = bob.snapshot()
  const initialApp = structuredClone(seed['state'])
  const values = new Map<string, unknown>([['core', initialCore], ['app', initialApp]])
  const order: string[] = []
  let rejectBatch = false
  const send = vi.fn(() => { order.push('ack') })
  const close = vi.fn()
  const store = {
    putBatch: async (entries: readonly (readonly [string, Uint8Array])[]) => {
      if (rejectBatch) throw new Error('ratchet batch rejected')
      for (const [key, value] of entries) {
        values.set(key, key === 'app' ? JSON.parse(new TextDecoder().decode(value)) : value.slice())
      }
      order.push('batch')
    },
    putJson: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
    getJson: async (key: string) => values.get(key),
  } as unknown as Engine['store']
  const newEngine = () => {
    // Load the fake store directly. This does not exercise normal engine startup.
    const engine = new Engine(() => {})
    engine['core'] = CoreClient.restore(values.get('core') as Uint8Array)
    engine['state'] = structuredClone(values.get('app')) as Engine['state']
    engine['account'] = { accountId: '33'.repeat(16), deviceId: '44'.repeat(16), username: 'bob', displayName: 'Bob', token: '' }
    engine['store'] = store
    engine['ws'] = { send, close } as unknown as Engine['ws']
    engine['flushOutbox'] = vi.fn(async () => {})
    return engine
  }
  const frame = {
    conversationId: started.conversationId,
    messageId: randomId(),
    envelope: alice.sendGroupTopic(started.conversationId, 'private topic', 1, 10, randomId()),
    welcome: false,
  } as Parameters<Engine['onDeliver']>[0]
  return { id, frame, alice, newEngine, send, close, values, initialCore, initialApp, order,
    failBatch: (fail: boolean) => { rejectBatch = fail } }
}

describe('disabled group topic delivery', () => {
  it('discards the topic and persists the consumed ratchet before acknowledgement', async () => {
    const { id, frame, alice, newEngine, order, values } = setupTopicDelivery()
    const engine = newEngine()
    await engine['onDeliver'](frame)
    expect(order).toEqual(['batch', 'ack'])
    expect(values.has('messages:' + id)).toBe(false)
    expect(JSON.stringify(values.get('app'))).not.toContain('private topic')
    expect(engine['state'].conversations[id]).toEqual({ id, peers: ['11'.repeat(16)], lastAt: 1 })

    const restored = CoreClient.restore(values.get('core') as Uint8Array)
    expect(restored.receive(alice.sendText(frame.conversationId, 'after topic', 11, randomId())).text).toBe('after topic')
  })

  it('fences failed storage without acknowledging; a fresh engine can replay the topic', async () => {
    const { id, frame, alice, newEngine, send, close, values, initialCore, initialApp, order, failBatch } = setupTopicDelivery()
    const engine = newEngine()
    failBatch(true)
    await expect(engine['onDeliver'](frame)).rejects.toThrow('ratchet batch rejected')
    expect(close).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    expect(values.get('core')).toBe(initialCore)
    expect(values.get('app')).toBe(initialApp)

    failBatch(false)
    await engine['onDeliver'](frame)
    expect(order).toEqual([])

    await newEngine()['onDeliver'](frame)
    expect(order).toEqual(['batch', 'ack'])
    expect(values.has('messages:' + id)).toBe(false)
    expect(JSON.stringify(values.get('app'))).not.toContain('private topic')
    const restored = CoreClient.restore(values.get('core') as Uint8Array)
    expect(restored.receive(alice.sendText(frame.conversationId, 'after replay', 11, randomId())).text).toBe('after replay')
  })
})

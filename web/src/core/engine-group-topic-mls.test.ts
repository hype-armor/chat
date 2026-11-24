/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'
import { Engine } from './engine'
import { makeIdentity, randomId, toHex } from './ids'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) })
})

describe('disabled group topic delivery', () => {
  it('discards the topic and persists the consumed ratchet before acknowledgement', async () => {
    const alice = new PendingClient().intoClient(makeIdentity('11'.repeat(16), '22'.repeat(16)))
    const bob = new PendingClient().intoClient(makeIdentity('33'.repeat(16), '44'.repeat(16)))
    const started = alice.startConversation([makeIdentity('33'.repeat(16), '44'.repeat(16))], bob.keyPackages(1), randomId())
    bob.receive(started.welcome)
    const id = toHex(started.conversationId)
    const engine = new Engine(() => {})
    engine['core'] = bob
    engine['account'] = { accountId: '33'.repeat(16), deviceId: '44'.repeat(16), username: 'bob', displayName: 'Bob', token: '' }
    engine['state'].conversations[id] = { id, peers: ['11'.repeat(16)], lastAt: 1 }
    const values = new Map<string, unknown>()
    engine['store'] = {
      putBatch: async (entries: readonly (readonly [string, Uint8Array])[]) => {
        for (const [key, value] of entries) {
          values.set(key, key === 'app' ? JSON.parse(new TextDecoder().decode(value)) : value.slice())
        }
      },
      putJson: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
      getJson: async (key: string) => values.get(key),
    } as unknown as Engine['store']
    const send = vi.fn()
    engine['ws'] = { send } as unknown as Engine['ws']
    engine['flushOutbox'] = vi.fn(async () => {})
    const messageId = randomId()
    const frame = {
      conversationId: started.conversationId,
      messageId,
      envelope: alice.sendGroupTopic(started.conversationId, 'private topic', 1, 10, randomId()),
      welcome: false,
    } as Parameters<Engine['onDeliver']>[0]

    await engine['onDeliver'](frame)
    expect(send).toHaveBeenCalledTimes(1)
    expect(values.has('messages:' + id)).toBe(false)
    expect(JSON.stringify(values.get('app'))).not.toContain('private topic')
    expect(engine['state'].conversations[id]).toEqual({ id, peers: ['11'.repeat(16)], lastAt: 1 })

    const restored = CoreClient.restore(values.get('core') as Uint8Array)
    expect(restored.receive(alice.sendText(started.conversationId, 'after topic', 11, randomId())).text).toBe('after topic')
  })
})

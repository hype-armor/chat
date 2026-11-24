/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'
import { Engine } from './engine'
import { makeIdentity, randomId, toHex } from './ids'

beforeAll(() => initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) }))

describe('atomic engine snapshots with MLS', () => {
  it('retains the old pair on failure, retries, and reloads the committed ratchet and app state', async () => {
    const alice = new PendingClient().intoClient(makeIdentity('11'.repeat(16), '22'.repeat(16)))
    const bob = new PendingClient().intoClient(makeIdentity('33'.repeat(16), '44'.repeat(16)))
    const started = alice.startConversation([makeIdentity('33'.repeat(16), '44'.repeat(16))], bob.keyPackages(1), randomId())
    bob.receive(started.welcome)
    const id = toHex(started.conversationId)
    const events: unknown[] = []
    const engine = new Engine((event) => events.push(event))
    engine['core'] = bob
    engine['account'] = { accountId: '33'.repeat(16), deviceId: '44'.repeat(16), username: 'bob', displayName: 'Bob', token: '' }
    const values = new Map<string, Uint8Array>()
    let fail = false
    const putBatch = vi.fn(async (entries: readonly (readonly [string, Uint8Array])[]) => {
      if (fail) throw new Error('transaction aborted')
      for (const [key, value] of entries) values.set(key, value.slice())
    })
    engine['store'] = { putBatch, putJson: async () => {} } as unknown as Engine['store']
    await engine['exclusive'](() => engine['persist']())
    const oldCore = values.get('core')!.slice(), oldApp = values.get('app')!.slice()
    expect(bob.receive(alice.sendText(started.conversationId, 'first', 1, randomId())).text).toBe('first')
    engine['state'].conversations[id] = { id, peers: ['11'.repeat(16)], lastAt: 1 }
    engine['draftChanges'].set(id, { text: 'draft', revision: 1 } as never)
    fail = true
    await expect(engine['exclusive'](() => engine['persist']())).rejects.toThrow('transaction aborted')
    expect(values.get('core')).toEqual(oldCore)
    expect(values.get('app')).toEqual(oldApp)
    expect(events).toEqual([])
    fail = false
    await engine['exclusive'](() => engine['persist']())
    expect(events).toHaveLength(1)
    const restored = CoreClient.restore(values.get('core')!)
    const app = JSON.parse(new TextDecoder().decode(values.get('app')))
    expect(app.conversations[id].lastAt).toBe(1)
    expect(restored.receive(alice.sendText(started.conversationId, 'second', 2, randomId())).text).toBe('second')
  })
})

/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PendingClient, initSync } from './pkg/chat_core.js'
import { Engine } from './engine'
import { makeIdentity, randomId, toHex } from './ids'

beforeAll(() => initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) }))

describe('delivery failure fence', () => {
  for (const failure of ['receive', 'apply', 'persist'] as const) {
    it(`fences queued and later deliveries after ${failure} fails`, async () => {
      const alice = new PendingClient().intoClient(makeIdentity('11'.repeat(16), '22'.repeat(16)))
      const bob = new PendingClient().intoClient(makeIdentity('33'.repeat(16), '44'.repeat(16)))
      const started = alice.startConversation([makeIdentity('33'.repeat(16), '44'.repeat(16))], bob.keyPackages(1), randomId())
      bob.receive(started.welcome)
      const engine = new Engine(() => {})
      engine['core'] = bob
      const id = toHex(started.conversationId)
      engine['state'].conversations[id] = { id, peers: [], lastAt: 1 }
      const send = vi.fn()
      const close = vi.fn()
      engine['ws'] = { send, close } as unknown as Engine['ws']
      const apply = vi.spyOn(engine as never, 'apply' as never) as unknown as ReturnType<typeof vi.fn>
      apply.mockImplementation(async () => { if (failure === 'apply') throw new Error('apply failed') })
      const persist = vi.spyOn(engine as never, 'persist' as never) as unknown as ReturnType<typeof vi.fn>
      persist.mockImplementation(async () => { if (failure === 'persist') throw new Error('persist failed') })
      const frame = {
        conversationId: started.conversationId,
        messageId: randomId(),
        envelope: failure === 'receive' ? new Uint8Array([1, 2, 3]) : alice.sendText(started.conversationId, 'first', 1, randomId()),
        welcome: false,
      } as Parameters<Engine['onDeliver']>[0]
      const first = engine['onDeliver'](frame)
      const queued = engine['onDeliver']({ ...frame, messageId: randomId() } as Parameters<Engine['onDeliver']>[0])
      await expect(first).rejects.toThrow()
      await queued
      await engine['onDeliver'](frame)
      expect(send).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
      expect(apply).toHaveBeenCalledTimes(failure === 'receive' ? 0 : 1)
      expect(persist).toHaveBeenCalledTimes(failure === 'persist' ? 1 : 0)
    })
  }

  it('blocks later writes and permits sign-out, but requires a fresh engine', async () => {
    const engine = new Engine(() => {})
    engine['deliveryFenced'] = true
    const write = vi.fn()
    await expect(engine['exclusive'](async () => { write() })).rejects.toThrow('fresh engine')
    await expect(engine['persist']()).rejects.toThrow('fresh engine')
    expect(write).not.toHaveBeenCalled()
    engine['store'] = { clear: vi.fn().mockResolvedValue(undefined) } as unknown as Engine['store']
    await engine['signOut']('signed out')
    await expect(engine['exclusive'](async () => {})).rejects.toThrow('fresh engine')
    expect(new Engine(() => {})['deliveryFenced']).toBe(false)
  })

  it('acknowledges a duplicate only after persistence and fences an ACK failure', async () => {
    const engine = new Engine(() => {})
    const messageId = randomId()
    engine['recent'].add(toHex(messageId))
    const persist = vi.spyOn(engine as unknown as { persist: Engine['persist'] }, 'persist').mockResolvedValue(undefined)
    const close = vi.fn()
    const send = vi.fn(() => { throw new Error('send failed') })
    engine['ws'] = { send, close } as unknown as Engine['ws']
    const frame = { messageId, conversationId: randomId(), envelope: new Uint8Array(), welcome: false } as Parameters<Engine['onDeliver']>[0]
    await expect(engine['onDeliver'](frame)).rejects.toThrow('send failed')
    expect(persist).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(engine['deliveryFenced']).toBe(true)
  })

  for (const replacement of ['socket', 'session'] as const) {
    it(`does not close a replacement ${replacement} incorrectly`, async () => {
      const engine = new Engine(() => {})
      const oldSocket = { close: vi.fn(), send: vi.fn() }
      const newSocket = { close: vi.fn(), send: vi.fn() }
      engine['ws'] = oldSocket as unknown as Engine['ws']
      let fail!: (error: Error) => void
      let started!: () => void
      const entered = new Promise<void>((resolve) => { started = resolve })
      vi.spyOn(engine as unknown as { persist: Engine['persist'] }, 'persist').mockImplementation(() => {
        started()
        return new Promise<void>((_resolve, reject) => { fail = reject })
      })
      const frame = { messageId: randomId(), conversationId: randomId(), envelope: new Uint8Array(), welcome: false } as Parameters<Engine['onDeliver']>[0]
      const delivery = engine['onDeliver'](frame, () => engine['ws'] === oldSocket as unknown as Engine['ws'])
      await entered
      engine['ws'] = newSocket as unknown as Engine['ws']
      if (replacement === 'session') engine['draftEpoch']++
      fail(new Error('storage failed'))
      await expect(delivery).rejects.toThrow('storage failed')
      expect(newSocket.close).toHaveBeenCalledTimes(replacement === 'socket' ? 1 : 0)
      expect(engine['deliveryFenced']).toBe(replacement === 'socket')
      expect(newSocket.send).not.toHaveBeenCalled()
    })
  }

  it('handles the rejected delivery promise at the frame boundary', async () => {
    const engine = new Engine(() => {})
    const close = vi.fn()
    const send = vi.fn()
    engine['ws'] = { send, close } as unknown as Engine['ws']
    const conversationId = randomId()
    engine['state'].conversations[toHex(conversationId)] = { id: toHex(conversationId), peers: [], lastAt: 1 }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      engine['onFrame']({ kind: 'deliver', conversationId, messageId: randomId(), envelope: new Uint8Array(), welcome: false } as Parameters<Engine['onFrame']>[0])
      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
      expect(close).toHaveBeenCalledOnce()
      expect(send).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

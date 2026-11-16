/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { initSync } from './pkg/chat_core.js'

beforeAll(() => initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) }))

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = Socket.OPEN
  binaryType = ''
  onopen?: () => void
  onmessage?: (event: { data: ArrayBuffer }) => void
  onclose?: () => void
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3; this.onclose?.() })
  constructor(_url: URL) { Socket.instances.push(this) }
}
const account = (id: string) => ({ accountId: id.repeat(16), deviceId: '22'.repeat(16), username: id, displayName: id, token: 'synthetic-' + id })
function setup() {
  const engine = new Engine(() => {})
  engine['account'] = account('11')
  engine['core'] = { snapshot: () => new Uint8Array([1]) } as unknown as NonNullable<Engine['core']>
  engine['store'] = { getJson: async () => undefined, putJson: vi.fn(async () => {}), putBytes: vi.fn(async () => {}), clear: vi.fn(async () => {}) } as unknown as Engine['store']
  engine['replenishKeyPackages'] = vi.fn(async () => {})
  engine['resolvePendingCommit'] = vi.fn(async () => {})
  engine['commitDepartures'] = vi.fn()
  engine['scheduleSync'] = vi.fn()
  engine['resumeTransfers'] = vi.fn()
  return engine
}
function replacement(engine: Engine) {
  engine['draftEpoch']++
  engine['endingSession'] = false
  engine['account'] = account('99')
  engine['core'] = { snapshot: () => new Uint8Array([9]) } as unknown as NonNullable<Engine['core']>
  engine['connect']()
  return Socket.instances.at(-1)!
}
const emit = (socket: Socket, bytes: number[]) => socket.onmessage?.({ data: new Uint8Array(bytes).buffer })
const AUTH = [0x32, 0] // ServerFrame.auth_result, empty AuthResult.
const REVOKED = [0x2a, 3, 8, 0x91, 3] // ServerFrame.error, Error.code = 401.

beforeEach(() => {
  vi.useFakeTimers()
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('self', { location: { href: 'https://socket-fixture.invalid/' } })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('socket and account session isolation', () => {
  it('resolves old waiters at sign-out without waiting for onclose or the request timeout', async () => {
    const engine = setup()
    engine['connect']()
    const old = Socket.instances[0]
    const pending = engine['request'](() => new Uint8Array([1]))
    expect(engine['waiters'].size).toBe(1)
    const reset = engine['signOut']('Reset')
    await expect(pending).resolves.toBeUndefined()
    await reset
    expect(engine['waiters'].size).toBe(0)
    expect(old.close).toHaveBeenCalledOnce()
    expect(engine['connection']).toBe('offline')
  })

  it('unblocks a lock-held flush immediately when sign-out starts', async () => {
    const engine = setup()
    engine['connect']()
    engine['connection'] = 'online'
    engine['state'].outbox.push({ messageId: '33'.repeat(16), conversationId: '44'.repeat(16), envelope: '', recipients: [] })
    let started!: () => void
    const waiting = new Promise<void>((resolve) => { started = resolve })
    const request = engine['request'].bind(engine)
    engine['request'] = (encode) => { const pending = request(encode); started(); return pending }
    const sending = engine['exclusive'](() => engine['flushOutbox'](true))
    await waiting
    const reset = engine['signOut']('Reset')
    await sending
    await reset
    expect(engine['flushing']).toBe(false)
    expect(engine['state'].outbox).toEqual([])
    expect(engine['waiters'].size).toBe(0)
  })

  it('ignores old open/auth/revocation/close callbacks and preserves replacement waiters', async () => {
    const engine = setup()
    engine['connect']()
    const old = Socket.instances[0]
    await engine['signOut']('Reset')
    const current = replacement(engine)
    const seen = vi.fn<Engine['onFrame']>()
    engine['onFrame'] = seen
    const pending = engine['request'](() => new Uint8Array([1]))
    const newRequest = [...engine['waiters'].keys()][0]
    const sentBefore = old.send.mock.calls.length
    old.onopen?.()
    emit(old, AUTH)
    emit(old, REVOKED)
    // A malformed stale frame must not reach the decoder either.
    expect(() => emit(old, [255])).not.toThrow()
    old.onclose?.()
    expect(seen).not.toHaveBeenCalled()
    expect(old.send).toHaveBeenCalledTimes(sentBefore)
    expect(engine['ws']).toBe(current)
    expect(engine['connection']).toBe('connecting')
    expect(engine['account']?.accountId).toBe('99'.repeat(16))
    expect(engine['waiters'].has(newRequest)).toBe(true)
    emit(current, AUTH)
    expect(seen).toHaveBeenCalledOnce()
    expect(seen.mock.calls[0][0].kind).toBe('auth')
    seen.mock.calls[0][0].free()
    await engine['signOut']('Reset again')
    await expect(pending).resolves.toBeUndefined()
  })

  it('does not run queued authentication work after its socket session ends', async () => {
    const engine = setup()
    const keyPackages = vi.fn(() => [])
    engine['core'] = { ...engine['core'], keyPackages } as unknown as NonNullable<Engine['core']>
    engine['replenishKeyPackages'] = Engine.prototype['replenishKeyPackages'].bind(engine)
    engine['connect']()
    const old = Socket.instances[0]
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holding = engine['exclusive'](async () => { entered(); await gate })
    await enteredPromise
    emit(old, AUTH)
    const reset = engine['signOut']('Reset')
    release()
    await holding
    await reset
    await engine['lock']
    expect(keyPackages).not.toHaveBeenCalled()
    expect(engine['resolvePendingCommit']).not.toHaveBeenCalled()
    expect(engine['commitDepartures']).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).not.toHaveBeenCalled()
    expect(engine['resumeTransfers']).not.toHaveBeenCalled()
  })

  it('does not process or acknowledge a queued delivery from an ended socket session', async () => {
    const engine = setup()
    engine['connect']()
    const old = Socket.instances[0]
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holding = engine['exclusive'](async () => { entered(); await gate })
    await enteredPromise
    const delivery = engine['onDeliver']({ envelope: new Uint8Array(), messageId: new Uint8Array(16), conversationId: new Uint8Array(16) } as Parameters<Engine['onDeliver']>[0], () => engine['ws'] === old as unknown as WebSocket && !engine['endingSession'])
    const reset = engine['signOut']('Reset')
    release()
    await holding
    await delivery
    await reset
    const current = replacement(engine)
    expect(old.send).not.toHaveBeenCalled()
    expect(current.send).not.toHaveBeenCalled()
    expect(engine['store'].putBytes).not.toHaveBeenCalled()
    expect(engine['commitDepartures']).not.toHaveBeenCalled()
  })
})

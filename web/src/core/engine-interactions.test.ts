import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { fromHex, makeIdentity } from './ids'
import type { CoreEvent } from './protocol'

const account = '11'.repeat(16)
const device = '22'.repeat(16)
const peer = '33'.repeat(16)
const peerDevice = '44'.repeat(16)
const otherDevice = '45'.repeat(16)
const conversationId = '55'.repeat(16)
const secondId = '56'.repeat(16)
const targetId = '66'.repeat(16)
const originalHash = 'aa'.repeat(32)
const sentHash = 'bb'.repeat(32)
const me = makeIdentity(account, device)
const sender = makeIdentity(peer, peerDevice)

function setup() {
  const events: CoreEvent[] = []
  const engine = new Engine((e) => events.push(e))
  const values = new Map<string, unknown>()
  const sendText = vi.fn((..._args: unknown[]) => new Uint8Array([1]))
  const sendTyping = vi.fn((..._args: unknown[]) => new Uint8Array([2]))
  const members = vi.fn(() => [me, sender, makeIdentity(peer, otherDevice)])
  engine['account'] = { accountId: account, deviceId: device, username: 'me', displayName: 'Me', token: '' }
  engine['core'] = { identity: () => me, members, sendText, sendTyping, lastSentContentHash: fromHex(sentHash), snapshot: () => new Uint8Array([3]) } as unknown as NonNullable<Engine['core']>
  engine['connection'] = 'online'
  engine['state'].names[peer] = 'Alex'
  for (const id of [conversationId, secondId]) engine['state'].conversations[id] = { id, peers: [peer], lastAt: 0 }
  engine['store'] = {
    getJson: async (key: string) => values.get(key),
    putJson: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
    putBytes: vi.fn(async () => {}),
  } as unknown as Engine['store']
  const request = vi.fn<Engine['request']>(async () => undefined)
  engine['request'] = request
  engine['flushOutbox'] = vi.fn(async () => {})
  const apply = (fields: Record<string, unknown>, id = '77'.repeat(16)) => engine['apply']({
    kind: 'message', conversationId: fromHex(conversationId), sender, sentAtMs: Date.now(), ...fields,
  } as Parameters<Engine['apply']>[0], id)
  return { engine, events, values, sendText, sendTyping, members, request, apply }
}

afterEach(() => vi.useRealTimers())

describe('engine typing integration', () => {
  it('throttles, persists the ratchet before sending, and never queues typing', async () => {
    vi.useFakeTimers()
    const { engine, sendTyping, values, request } = setup()
    await engine.setTyping(conversationId, true)
    await engine.setTyping(conversationId, true)
    expect(sendTyping).toHaveBeenCalledTimes(1)
    expect(engine['store'].putBytes).toHaveBeenCalledWith('core', new Uint8Array([3]))
    expect(vi.mocked(engine['store'].putBytes).mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0])
    expect(engine['state'].outbox).toEqual([])
    expect(values.has(`messages:${conversationId}`)).toBe(false)
    expect(JSON.stringify(values.get('app'))).not.toContain('typingSent')
    vi.advanceTimersByTime(3_000)
    await engine.setTyping(conversationId, true)
    await engine.setTyping(secondId, true)
    expect(sendTyping.mock.calls.map((args) => args[1])).toEqual([true, true, false, true])
  })

  it('clears on send, disconnect, and disabling; the preference persists', async () => {
    vi.useFakeTimers()
    const { engine, apply, events, sendTyping, values } = setup()
    await apply({ typingActive: true, typingExpiresAtMs: Date.now() + 8_000 })
    expect(engine.typing(conversationId)).toEqual([{ account: peer, name: 'Alex' }])
    await engine.setTyping(conversationId, true)
    await engine.sendText(conversationId, 'Hello')
    await engine['lock']
    expect(sendTyping.mock.calls.map((args) => args[1])).toEqual([true, false])
    await engine.setTypingIndicators(false)
    expect(engine.typing(conversationId)).toEqual([])
    expect(values.get('app')).toMatchObject({ typingIndicators: false })
    await engine.setTyping(conversationId, true)
    expect(sendTyping).toHaveBeenCalledTimes(2)
    await engine.setTypingIndicators(true)
    await apply({ typingActive: true, typingExpiresAtMs: Date.now() + 8_000 })
    engine['setConnection']('offline')
    expect(engine.typing(conversationId)).toEqual([])
    expect(events.at(-2)).toEqual({ type: 'typing', conversationId, typists: [] })
  })

  it('deduplicates authenticated devices; expires without history, unread, or receipts', async () => {
    vi.useFakeTimers()
    const { engine, apply, events, values } = setup()
    await apply({ typingActive: true, typingExpiresAtMs: Date.now() + 8_000 })
    await apply({ sender: makeIdentity(peer, otherDevice), typingActive: true, typingExpiresAtMs: Date.now() + 8_000 })
    expect(engine.typing(conversationId)).toEqual([{ account: peer, name: 'Alex' }])
    expect(events.filter((e) => e.type === 'typing')).toHaveLength(1)
    expect(engine['state'].conversations[conversationId].unread).toBeUndefined()
    expect(engine['receipts'].size).toBe(0)
    expect(values.size).toBe(0)
    expect(events.every((e) => e.type === 'typing')).toBe(true)
    vi.advanceTimersByTime(8_250)
    expect(engine.typing(conversationId)).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'typing', conversationId, typists: [] })
    engine['clearTyping']()
  })

  it('retains the receiver time floor after pruning and rejects a delayed start after rollback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const { engine, apply } = setup()
    await apply({ typingActive: false, sentAtMs: 52_000, typingExpiresAtMs: 62_000 })
    vi.advanceTimersByTime(12_250)
    expect(engine['typingLeases'].size).toBe(0)
    vi.setSystemTime(50_000)
    await apply({ typingActive: true, sentAtMs: 51_999, typingExpiresAtMs: 61_999 })
    expect(engine.typing(conversationId)).toEqual([])
    engine['clearTyping']()
  })

  it('records a message tombstone before any typing lease exists', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const { engine, apply } = setup()
    await apply({ text: 'Already sent', sentAtMs: 50_001 })
    await apply({ typingActive: true, sentAtMs: 50_000, typingExpiresAtMs: 58_000 })
    expect(engine.typing(conversationId)).toEqual([])
    engine['clearTyping']()
    clearTimeout(engine['receiptTimer'])
  })

  it('orders concurrent conversation changes and generates increasing start and stop timestamps', async () => {
    vi.useFakeTimers()
    const { engine, sendTyping } = setup()
    await Promise.all([engine.setTyping(conversationId, true), engine.setTyping(secondId, true)])
    expect(sendTyping.mock.calls.map((args) => args[1])).toEqual([true, false, true])
    const times = sendTyping.mock.calls.map((args) => args[2] as number)
    expect(times[1]).toBeGreaterThan(times[0])
    expect(times[2]).toBeGreaterThan(times[1])
  })

  it('keeps another device typing when one device sends a message', async () => {
    vi.useFakeTimers()
    const { engine, apply } = setup()
    await apply({ typingActive: true, typingExpiresAtMs: Date.now() + 8_000 })
    await apply({ sender: makeIdentity(peer, otherDevice), typingActive: true, typingExpiresAtMs: Date.now() + 8_000 })
    await apply({ text: 'Sent from one device' })
    expect(engine.typing(conversationId)).toEqual([{ account: peer, name: 'Alex' }])
    await apply({ sender: makeIdentity(peer, otherDevice), text: 'Sent from the other device' })
    expect(engine.typing(conversationId)).toEqual([])
    engine['clearTyping']()
    clearTimeout(engine['receiptTimer'])
  })

  it('catches best-effort request failures and never sends before MLS persistence succeeds', async () => {
    const { engine, request } = setup()
    request.mockRejectedValueOnce(new Error('Socket closed'))
    await expect(engine.setTyping(conversationId, true)).resolves.toBeUndefined()
    await Promise.resolve()
    vi.mocked(engine['store'].putBytes).mockRejectedValueOnce(new Error('Storage failed'))
    await expect(engine.setTyping(conversationId, false)).rejects.toThrow('Storage failed')
    expect(request).toHaveBeenCalledTimes(1)
    expect(engine['state'].outbox).toEqual([])
  })

  it.each(['blocked', 'request', 'removed', 'foreign', 'offline'] as const)('rejects %s typing', async (reason) => {
    vi.useFakeTimers()
    const { engine, apply } = setup()
    if (reason === 'blocked') engine['state'].blocked.push(peer)
    if (reason === 'request') engine['state'].conversations[conversationId].request = true
    if (reason === 'removed') engine['state'].conversations[conversationId].status = 'removed'
    if (reason === 'offline') engine['connection'] = 'offline'
    await apply({ typingActive: true, typingExpiresAtMs: Date.now() + 8_000, ...(reason === 'foreign' ? { sender: makeIdentity('99'.repeat(16), peerDevice) } : {}) })
    expect(engine.typing(conversationId)).toEqual([])
    engine['clearTyping']()
  })
})

describe('engine encrypted replies', () => {
  it('keeps references in the queued ciphertext, stored message, retry, and reload view', async () => {
    const { engine, values, sendText } = setup()
    values.set(`messages:${conversationId}`, [{ id: targetId, from: peer, text: 'Original', sentAt: 1, status: 'received' }])
    ;(values.get(`messages:${conversationId}`) as { contentHash?: string }[])[0].contentHash = originalHash
    await engine.sendText(conversationId, 'Reply', targetId)
    await engine['lock']
    expect(sendText.mock.calls[0]?.[4]).toEqual(fromHex(targetId))
    expect(sendText.mock.calls[0]?.[5]).toEqual(fromHex(originalHash))
    const list = await engine.messages(conversationId)
    expect(list[1]).toMatchObject({ replyTo: targetId, reply: { from: peer, fromName: 'Alex', text: 'Original' } })
    const stored = values.get(`messages:${conversationId}`) as { id: string; status: string; replyTo?: string; replyToHash?: string; contentHash?: string; reply?: unknown }[]
    expect(stored[1].replyTo).toBe(targetId)
    expect(stored[1].replyToHash).toBe(originalHash)
    expect(stored[1].contentHash).toBe(sentHash)
    expect(stored[1].reply).toBeUndefined()
    stored[1].status = 'failed'
    await engine.retryMessage(conversationId, stored[1].id)
    expect(sendText.mock.calls[1]?.[4]).toEqual(fromHex(targetId))
    expect(sendText.mock.calls[1]?.[5]).toEqual(fromHex(originalHash))
    expect(engine['state'].outbox).toHaveLength(2)
    await expect(engine.sendText(secondId, 'Wrong conversation', targetId)).rejects.toThrow('not in this conversation')
  })

  it('does not verify substituted IDs or legacy targets without authenticated content hashes', async () => {
    const { engine, apply, values } = setup()
    values.set(`messages:${conversationId}`, [{ id: targetId, from: peer, text: 'Substituted original', sentAt: 1, status: 'received', contentHash: 'cc'.repeat(32) }])
    await apply({ sender: me, text: 'Forged quote', replyTo: fromHex(targetId), replyToHash: fromHex(originalHash) })
    expect((await engine.messages(conversationId))[1].reply).toMatchObject({ unavailable: true })
    await apply({ sender: me, text: 'Legacy quote', replyTo: fromHex(targetId) }, '78'.repeat(16))
    expect((await engine.messages(conversationId))[2].reply).toMatchObject({ unavailable: true })
    values.set(`messages:${secondId}`, [{ id: targetId, from: peer, text: 'Legacy target', sentAt: 1, status: 'received' }])
    await expect(engine.sendText(secondId, 'Cannot authenticate the original', targetId)).rejects.toThrow('cannot be verified')
  })

  it('preserves incoming own-device references and resolves unavailable targets safely', async () => {
    const { engine, apply, values } = setup()
    values.set(`messages:${conversationId}`, [{ id: targetId, from: peer, text: 'Original', sentAt: 1, status: 'received' }])
    ;(values.get(`messages:${conversationId}`) as { contentHash?: string }[])[0].contentHash = originalHash
    await apply({ sender: me, text: 'Own linked device reply', replyTo: fromHex(targetId), replyToHash: fromHex(originalHash), contentHash: fromHex(sentHash) })
    expect((await engine.messages(conversationId))[1]).toMatchObject({ from: 'me', replyTo: targetId, reply: { from: peer, text: 'Original' } })
    await apply({ sender: me, text: 'Unknown target', replyTo: fromHex('88'.repeat(16)) }, '78'.repeat(16))
    expect((await engine.messages(conversationId))[2].reply).toMatchObject({ unavailable: true })
  })
})

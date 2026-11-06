import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { fromHex } from './ids'
import { MAX_LIVE_DURATION_MS } from './live'
import * as maps from './maps'
import type { ChatMessage } from './protocol'

const conversationId = '11'.repeat(16)
const sessionId = '22'.repeat(16)
const messageId = '33'.repeat(16)
const peer = '44'.repeat(16)
const now = 10 * MAX_LIVE_DURATION_MS
const point = { latitude: 48.8584, longitude: 2.2945, accuracyM: 12 }

function fixture(from: string) {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.spyOn(maps, 'prepareArea').mockImplementation(() => {})
  const engine = new Engine(() => {})
  const values = new Map<string, unknown>()
  const message: ChatMessage = {
    id: messageId,
    from,
    text: '',
    sentAt: now - MAX_LIVE_DURATION_MS - 1000,
    status: from === 'me' ? 'sent' : 'received',
    live: { sessionId, expiresAt: now - 1000, untilStopped: true, ended: true },
  }
  values.set(`messages:${conversationId}`, [message])
  engine['store'] = {
    getJson: async (key: string) => structuredClone(values.get(key)),
    putJson: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
    putBytes: async () => {},
  } as unknown as Engine['store']
  const sendLiveLocation = vi.fn((..._args: unknown[]) => new Uint8Array([1]))
  engine['core'] = { sendLiveLocation, snapshot: () => new Uint8Array() } as unknown as Engine['core']
  engine['account'] = {
    accountId: '55'.repeat(16), deviceId: '66'.repeat(16), username: 'test.00', displayName: 'Test', token: 'test',
  }
  engine['state'].conversations[conversationId] = { id: conversationId, peers: [peer], lastAt: message.sentAt, unread: 0 }
  engine['recipients'] = () => []
  engine['flushOutbox'] = vi.fn(async () => {})
  engine['scheduleLiveSweep'] = vi.fn()
  const stored = () => structuredClone(values.get(`messages:${conversationId}`)) as Parameters<Engine['encode']>[2][]
  return { engine, stored, sendLiveLocation }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('one card per live share', () => {
  it('expires a paused card once without repeated writes or view events', async () => {
    const { engine, stored } = fixture('me')
    const message = stored()[0]
    message.live!.ended = false
    message.live!.latest = { ...point, at: now - MAX_LIVE_DURATION_MS - 1000 }
    await engine['store'].putJson(`messages:${conversationId}`, [message])
    engine['state'].live.push({
      sessionId, conversationId, messageId, expiresAt: now - 1000, untilStopped: true,
      lastSentAt: now - MAX_LIVE_DURATION_MS - 1000,
    })
    const writes = vi.spyOn(engine['store'], 'putBytes')
    const views = vi.fn()
    engine['emitView'] = views
    await engine['endExpiredLive']()
    expect(stored()[0].live).toMatchObject({ ended: true })
    expect(stored()[0].live?.latest).toBeUndefined()
    expect(engine['state'].live).toHaveLength(1)
    expect(writes).toHaveBeenCalledTimes(1)
    expect(views).toHaveBeenCalledTimes(1)
    await engine['endExpiredLive']()
    await engine['endExpiredLive']()
    expect(writes).toHaveBeenCalledTimes(1)
    expect(views).toHaveBeenCalledTimes(1)
  })

  it('renews the sender card with the same IDs after an 8-hour pause', async () => {
    const { engine, stored, sendLiveLocation } = fixture('me')
    engine['connection'] = 'online'
    engine['state'].live.push({
      sessionId, conversationId, messageId, expiresAt: now - 1000, untilStopped: true,
      lastSentAt: now - MAX_LIVE_DURATION_MS - 1000,
    })
    await engine.liveUpdate(point)
    expect(stored()).toHaveLength(1)
    expect(stored()[0]).toMatchObject({
      id: messageId,
      live: { sessionId, ended: false, latest: { ...point, at: now }, expiresAt: now + MAX_LIVE_DURATION_MS },
    })
    expect(engine['state'].live[0]).toMatchObject({ sessionId, messageId })
    expect(engine['state'].outbox).toHaveLength(1)
    expect(engine['state'].outbox[0].silent).toBe(true)
    expect(sendLiveLocation.mock.calls[0]?.[1]).toEqual(fromHex(sessionId))
  })

  it('encodes an until-stopped retry against its renewed lease timestamp', () => {
    const { engine, stored, sendLiveLocation } = fixture('me')
    const message = stored()[0]
    message.live = {
      sessionId,
      expiresAt: now + MAX_LIVE_DURATION_MS,
      untilStopped: true,
      latest: { ...point, at: now },
      ended: false,
    }

    engine['encode'](engine['core']!, conversationId, message)

    expect(sendLiveLocation.mock.calls[0]?.[8]).toBe(now)
  })

  it('renews the receiver card and its expiry without adding an unread message', async () => {
    const { engine, stored } = fixture(peer)
    await engine['applyLive'](conversationId, peer, false, '77'.repeat(16), now, {
      sessionId: fromHex(sessionId), expiresAtMs: now + MAX_LIVE_DURATION_MS, untilStopped: true,
      stopped: false, location: { ...point, label: '', free: () => {} },
    } as Parameters<Engine['applyLive']>[5])
    expect(stored()).toHaveLength(1)
    expect(stored()[0]).toMatchObject({
      id: messageId,
      live: { sessionId, ended: false, latest: { ...point, at: now }, expiresAt: now + MAX_LIVE_DURATION_MS },
    })
    expect(engine['state'].conversations[conversationId].unread).toBe(0)
    expect(engine['state'].liveSeen).toEqual([{ conversationId, messageId, expiresAt: now + MAX_LIVE_DURATION_MS }])
  })

  it('never reopens a card after an explicit stop', async () => {
    const { engine, stored } = fixture(peer)
    const view = {
      sessionId: fromHex(sessionId), expiresAtMs: now + MAX_LIVE_DURATION_MS, untilStopped: true,
      stopped: true,
    } as Parameters<Engine['applyLive']>[5]
    await engine['applyLive'](conversationId, peer, false, '77'.repeat(16), now, view)
    await engine['applyLive'](conversationId, peer, false, '88'.repeat(16), now + 1000, {
      ...view, stopped: false, location: { ...point, label: '', free: () => {} },
    } as Parameters<Engine['applyLive']>[5])
    expect(stored()).toHaveLength(1)
    expect(stored()[0].live).toMatchObject({ ended: true, stopped: true })
    expect(stored()[0].live?.latest).toBeUndefined()
    expect(engine['state'].liveSeen).toHaveLength(0)
  })

  it('clears other members live points when this device leaves the group (issue #114)', async () => {
    const { engine, stored } = fixture(peer)
    const message = stored()[0]
    message.live = { sessionId, expiresAt: now + MAX_LIVE_DURATION_MS, untilStopped: true, ended: false, latest: { ...point, at: now } }
    await engine['store'].putJson(`messages:${conversationId}`, [message])
    engine['state'].liveSeen.push({ conversationId, messageId, expiresAt: now + MAX_LIVE_DURATION_MS })
    engine['core'] = { ...engine['core'], leave: vi.fn(() => new Uint8Array([2])) } as unknown as Engine['core']

    await engine.leaveGroup(conversationId)

    expect(engine['state'].conversations[conversationId].status).toBe('left')
    expect(engine['state'].liveSeen).toEqual([])
    expect(stored()[0].live).toMatchObject({ ended: true })
    expect(stored()[0].live?.latest).toBeUndefined()
  })
})

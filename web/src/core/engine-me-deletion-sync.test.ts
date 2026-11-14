/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { api } from './api'
import * as maps from './maps'
import { initSync, type CoreClient } from './pkg/chat_core.js'
import { fromHex, makeIdentity } from './ids'
import { emptyDeletions, type DeletionLedger } from './deletions'
import { ME_SYNC_MAX_BYTES, meDeletionBindings, meDeletionChunks, mergeMeDeletions, parseMeDeletions } from './me-deletion-sync'
import type { CoreEvent } from './protocol'

const me = '11'.repeat(16), a = '22'.repeat(16), b = '77'.repeat(16), c = '99'.repeat(16), peer = '33'.repeat(16)
const conversation = '55'.repeat(16), selfId = 'ee'.repeat(16), target = '66'.repeat(16), hash = 'aa'.repeat(32)
const binding = { conversation, hash, author: peer }, ledgerKey = 'deletions:' + me, historyKey = 'messages:' + conversation
const original = { id: target, from: peer, text: 'private original', sentAt: 1_000_000, status: 'received' as const, contentHash: hash }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const frame = (...records: unknown[]) => bytes({ names: {}, usernames: {}, conversations: {}, meDeletions: records })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
function setup(device = a) {
  const events: CoreEvent[] = [], values = new Map<string, unknown>([[historyKey, [structuredClone(original)]]])
  const engine = new Engine((event) => events.push(event))
  const identities = [a, b].map((d) => makeIdentity(me, d))
  const rosters = new Map([[selfId, identities], [conversation, [makeIdentity(me, device), makeIdentity(peer, '44'.repeat(16))]]])
  const core = { identity: () => makeIdentity(me, device), members: (id: Uint8Array) => rosters.get(Array.from(id, (n) => n.toString(16).padStart(2, '0')).join('')) ?? [], snapshot: () => new Uint8Array([2]), sendDeviceSync: vi.fn<CoreClient['sendDeviceSync']>(() => new Uint8Array([3])) }
  const store = { getJson: vi.fn(async (key: string) => structuredClone(values.get(key))), putJson: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }), deleteBytes: vi.fn(async (key: string) => { values.delete(key) }), putBytes: vi.fn(async () => {}), putFile: vi.fn(async () => {}), clear: vi.fn(async () => values.clear()) }
  engine['account'] = { accountId: me, deviceId: device, username: 'me', displayName: 'Me', token: 'synthetic' }
  engine['core'] = core as unknown as CoreClient; engine['store'] = store as unknown as Engine['store']
  engine['state'].myDevices = [a, b]
  // This fixture normally starts after a successful directory refresh. Restart tests can clear it.
  engine['meDirectorySession'] = engine['deletionSession']()
  engine['state'].conversations[conversation] = { id: conversation, peers: [peer], lastAt: original.sentAt }
  engine['state'].conversations[selfId] = { id: selfId, peers: [], self: true, lastAt: 0 }
  const flush = engine['flushOutbox'].bind(engine); engine['flushOutbox'] = vi.fn(async () => {})
  const apply = (data: Uint8Array, senderDevice = device === a ? b : a, id = selfId, account = me) => engine['apply']({ kind: 'message', conversationId: fromHex(id), sender: makeIdentity(account, senderDevice), sentAtMs: 1_000_100, deviceSync: data } as Parameters<Engine['apply']>[0], '88'.repeat(16))
  const ledger = () => values.get(ledgerKey) as DeletionLedger
  const chunks = () => core.sendDeviceSync.mock.calls.map((call) => call[1]).filter((value) => parseMeDeletions(value).length)
  return { engine, events, values, core, store, rosters, flush, apply, ledger, chunks }
}
beforeAll(() => initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) }))
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_100) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('private Me deletion synchronization', () => {
  it('whitelists only bindings, deduplicates semantic records, and never imports JSON authority flags', () => {
    const parsed = parseMeDeletions(frame({ ...binding, scope: 'everyone', verified: true, localIntent: true, eventId: target, requestAt: 1, originalAt: 1, status: 'sending' }, binding, { ...binding, hash: 'bad' }))
    expect(parsed).toEqual([binding])
    const ledger = emptyDeletions(); expect(mergeMeDeletions(ledger, parsed)).toEqual([binding])
    expect(ledger.records).toEqual([{ scope: 'me', ...binding, target: '', aliases: [] }])
    expect(ledger.meSyncRevision).toBe(1)
    expect(mergeMeDeletions(ledger, parsed)).toEqual([]); expect(ledger.meSyncRevision).toBe(1)
  })

  it('chunks the complete never-evicted Me union below the existing payload limit', () => {
    const ledger = emptyDeletions()
    const bindings = Array.from({ length: 2_100 }, (_, i) => ({ ...binding, hash: i.toString(16).padStart(64, '0') }))
    mergeMeDeletions(ledger, bindings)
    const chunks = meDeletionChunks(meDeletionBindings(ledger))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((data) => data.byteLength <= ME_SYNC_MAX_BYTES)).toBe(true)
    expect(chunks.flatMap(parseMeDeletions)).toEqual(bindings)
    expect(ledger.records).toHaveLength(2_100); expect(ledger.candidates).toEqual([])
  })

  it('atomically marks verified local Me intent dirty and queues only encrypted private own-device frames', async () => {
    const s = setup()
    expect((await s.engine.messages(conversation))[0].deleteForMeLocalOnly).toBe(false)
    await expect(s.engine.deleteMessage(conversation, target, 'me')).resolves.toEqual({ accepted: true, scope: 'me' })
    expect(await s.engine.messages(conversation)).toEqual([])
    const first = s.store.putJson.mock.calls.find(([key]) => key === ledgerKey)![1] as DeletionLedger
    expect(first.meSyncRevision).toBe(1); expect(first.records[0]).toMatchObject({ scope: 'me', hash, author: peer })
    expect(s.chunks()).toHaveLength(1)
    expect(parseMeDeletions(s.chunks()[0])).toEqual([binding])
    expect(s.engine['state'].outbox[0]).toMatchObject({ conversationId: selfId, envelope: 'Aw==', recipients: [b], meDeletionBatch: expect.any(String) })
    expect(s.ledger().meSyncAcknowledged).toBeUndefined()
  })

  it('keeps legacy and not-yet-encrypted originals device-only', async () => {
    const s = setup(); s.values.set(historyKey, [{ ...original, contentHash: undefined }])
    expect((await s.engine.messages(conversation))[0].deleteForMeLocalOnly).toBe(true)
    await s.engine.deleteMessage(conversation, target, 'me')
    expect(s.chunks()).toEqual([]); expect(s.ledger().meSyncRevision).toBeUndefined()
    expect(s.engine['state'].outbox).toHaveLength(0)
  })

  it('converges two devices, emits alias invalidations, and stops echoing duplicate records', async () => {
    const first = setup(a), second = setup(b), alias = '98'.repeat(16)
    second.values.set(historyKey, [original, { ...original, id: alias }])
    await second.engine.messages(conversation)
    await first.engine.deleteMessage(conversation, target, 'me')
    await second.apply(first.chunks()[0])
    expect(await second.engine.messages(conversation)).toEqual([])
    expect(second.events.filter((event) => event.type === 'messages' && event.deletions?.length)[0]).toEqual({ type: 'messages', conversationId: conversation, deletions: [{ messageId: target, scope: 'me' }, { messageId: alias, scope: 'me' }] })
    const revision = second.ledger().meSyncRevision
    await second.apply(first.chunks()[0]); expect(second.ledger().meSyncRevision).toBe(revision)
    second.engine['connection'] = 'online'; await second.engine['flushMeDeletionSync']()
    await first.apply(second.chunks()[0])
    expect(first.ledger().meSyncRevision).toBe(1)
    expect(first.chunks()).toHaveLength(1)
  })

  it('retains unknown-original account-owned suppression and hides only exact authentic matches later', async () => {
    const s = setup(b); s.values.set(historyKey, [])
    await s.apply(frame({ ...binding, scope: 'everyone', localIntent: true, verified: true, eventId: target }))
    expect(s.ledger().records).toHaveLength(1); expect(s.ledger().candidates).toHaveLength(0)
    expect(s.ledger().records[0]).toMatchObject({ scope: 'me', hash, author: peer })
    expect(s.ledger().records[0].localIntent).toBeUndefined()
    expect(s.events.filter((e) => e.type === 'messages' && e.deletions?.length)).toEqual([])
    await s.engine['appendMessage'](conversation, { ...original, contentHash: 'bb'.repeat(32) })
    expect((await s.engine.messages(conversation))[0].text).toBe(original.text)
    await s.engine['appendMessage'](conversation, { ...original, id: '97'.repeat(16) })
    expect(await s.engine.messages(conversation)).toHaveLength(1)
    expect(s.ledger().records[0].aliases).toEqual(['97'.repeat(16)])
    await expect(s.engine.retryDeletion(conversation, target)).rejects.toThrow('No accepted deletion intent')
  })

  it.each(['wrong account', 'normal conversation', 'revoked device', 'missing device context'] as const)('rejects %s without importing suppression', async (mode) => {
    const s = setup(a)
    if (mode === 'wrong account') { s.rosters.set(selfId, [makeIdentity(me, a), makeIdentity(peer, b)]); await s.apply(frame(binding), b, selfId, peer) }
    if (mode === 'normal conversation') await s.apply(frame(binding), a, conversation)
    if (mode === 'revoked device') { s.engine['state'].myDevices = [a]; await s.apply(frame(binding)) }
    if (mode === 'missing device context') await s.engine['applyDeviceSync'](selfId, frame(binding))
    expect(s.ledger()?.records ?? []).toHaveLength(0)
    expect((await s.engine.messages(conversation))[0].text).toBe(original.text)
  })

  it('refuses to send suppression into an ordinary or revoked-member conversation', async () => {
    const s = setup(); mergeMeDeletions(await s.engine['readDeletions'](), [binding])
    expect(await s.engine['queueMeDeletionSync'](conversation)).toBe(false)
    s.engine['state'].myDevices = [a]
    expect(await s.engine['queueMeDeletionSync'](selfId)).toBe(false)
    expect(s.chunks()).toEqual([])
  })

  it('includes the full union in future-device bootstrap after an earlier batch was acknowledged', async () => {
    const s = setup(); await s.engine.deleteMessage(conversation, target, 'me')
    s.engine['connection'] = 'online'; s.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true } as Awaited<ReturnType<Engine['request']>>))
    await s.flush(); expect(s.ledger().meSyncAcknowledged).toBe(s.ledger().meSyncRevision)
    s.engine['state'].myDevices = [a, b, c]; s.rosters.set(selfId, [a, b, c].map((d) => makeIdentity(me, d)))
    await s.engine['queueDeviceSync'](selfId); await s.engine['persist']()
    expect(s.chunks()).toHaveLength(2)
    const newcomer = setup(c); newcomer.engine['state'].myDevices = [a, b, c]; newcomer.rosters.set(selfId, [a, b, c].map((d) => makeIdentity(me, d))); newcomer.values.set(historyKey, [])
    await newcomer.apply(s.chunks()[1], a)
    expect(meDeletionBindings(newcomer.ledger())).toEqual([binding])
    await newcomer.engine['appendMessage'](conversation, original)
    expect(await newcomer.engine.messages(conversation)).toEqual([])
  })

  it('keeps dirty intent across offline acceptance, missing self groups, and a reconstructed engine', async () => {
    const s = setup(); delete s.engine['state'].conversations[selfId]
    await s.engine.deleteMessage(conversation, target, 'me')
    expect(s.ledger().meSyncRevision).toBe(1); expect(s.chunks()).toEqual([])
    const recovered = setup(); for (const [key, value] of s.values) recovered.values.set(key, structuredClone(value))
    recovered.engine['connection'] = 'online'; await recovered.engine['flushMeDeletionSync']()
    expect(recovered.chunks()).toHaveLength(1)
    expect(meDeletionBindings(recovered.ledger())).toEqual([binding])
  })

  it('keeps sync gated and retryable when app persistence fails after local tombstone acceptance', async () => {
    const s = setup(); s.store.putJson.mockImplementation(async (key, value) => { if (key === 'app') throw new Error('quota'); s.values.set(key, structuredClone(value)) })
    await expect(s.engine.deleteMessage(conversation, target, 'me')).resolves.toMatchObject({ accepted: true })
    s.engine['connection'] = 'online'; s.engine['request'] = vi.fn()
    await s.flush(); expect(s.engine['request']).not.toHaveBeenCalled()
    expect(s.ledger().meSyncRevision).toBe(1); expect(s.ledger().meSyncAcknowledged).toBeUndefined()
    expect(s.engine['state'].alerts.some((alert) => alert.id === 'me-deletion-sync')).toBe(true)
    const recovered = setup(); for (const [key, value] of s.values) recovered.values.set(key, structuredClone(value))
    recovered.engine['connection'] = 'online'; await recovered.engine['flushMeDeletionSync']()
    expect(recovered.chunks()).toHaveLength(1)
  })

  it('finishes a previously gated batch after a transient app failure without requiring reload', async () => {
    const s = setup()
    s.store.putJson.mockImplementation(async (key, value) => { if (key === 'app') throw new Error('quota'); s.values.set(key, structuredClone(value)) })
    await s.engine.deleteMessage(conversation, target, 'me')
    expect(s.engine['acceptingMeDeletionSync'].size).toBeGreaterThan(0)
    s.store.putJson.mockImplementation(async (key, value) => { s.values.set(key, structuredClone(value)) })
    s.engine['connection'] = 'online'; await s.engine['flushMeDeletionSync']()
    expect(s.engine['acceptingMeDeletionSync'].size).toBe(0)
    expect(s.chunks()).toHaveLength(1)
    expect((s.values.get('app') as { outbox: unknown[] }).outbox).toHaveLength(1)
  })

  it('cancels a queued batch if its private current-recipient context changed before transport', async () => {
    const s = setup(); await s.engine.deleteMessage(conversation, target, 'me')
    s.engine['state'].myDevices = [a]
    s.engine['connection'] = 'online'; s.engine['request'] = vi.fn()
    await s.flush()
    expect(s.engine['request']).not.toHaveBeenCalled()
    expect(s.engine['state'].outbox).toHaveLength(0)
    expect(s.ledger().meSyncAcknowledged).toBeUndefined()
    expect(s.ledger().meSyncRevision).toBe(1)
  })

  it('gates a new sync batch until the advanced ratchet and outbox are durable', async () => {
    const s = setup(), entered = deferred<void>(), gate = deferred<void>()
    s.store.putBytes.mockImplementation(async () => { entered.resolve(); await gate.promise })
    const deletion = s.engine.deleteMessage(conversation, target, 'me')
    await entered.promise; s.engine['connection'] = 'online'; s.engine['request'] = vi.fn()
    await s.flush(); expect(s.engine['request']).not.toHaveBeenCalled()
    gate.resolve(); await deletion
    expect(s.engine['acceptingMeDeletionSync'].size).toBe(0)
  })

  it('retries failed transport with durable dirty intent and clears the alert only after batch acknowledgement', async () => {
    const s = setup(); await s.engine.deleteMessage(conversation, target, 'me')
    s.engine['connection'] = 'online'; s.engine['request'] = vi.fn(async () => ({ kind: 'error', errorCode: 400 } as Awaited<ReturnType<Engine['request']>>))
    await s.flush(); expect(s.ledger().meSyncAcknowledged).toBeUndefined()
    expect(s.engine['state'].alerts.some((alert) => alert.id === 'me-deletion-sync')).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000); expect(s.chunks()).toHaveLength(2)
    s.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true } as Awaited<ReturnType<Engine['request']>>))
    await s.flush()
    expect(s.ledger().meSyncAcknowledged).toBe(s.ledger().meSyncRevision)
    expect(s.engine['state'].alerts.some((alert) => alert.id === 'me-deletion-sync')).toBe(false)
  })

  it('does not acknowledge a partially failed multi-frame batch as a complete union', async () => {
    const s = setup()
    await s.engine['changeDeletions']((ledger) => { mergeMeDeletions(ledger, Array.from({ length: 600 }, (_, i) => ({ ...binding, hash: i.toString(16).padStart(64, '0') }))); return true })
    s.engine['connection'] = 'online'; await s.engine['flushMeDeletionSync']()
    expect(s.chunks().length).toBeGreaterThan(1)
    s.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true } as Awaited<ReturnType<Engine['request']>>)).mockResolvedValueOnce({ kind: 'error', errorCode: 400 } as Awaited<ReturnType<Engine['request']>>)
    await s.flush()
    expect(s.ledger().meSyncAcknowledged).toBeUndefined()
    expect(s.engine['state'].outbox).toHaveLength(0)
    expect(s.ledger().meSyncRevision).toBe(1)
  })

  it('persists normalized incoming retry input when the ledger write fails and recovers it after reload', async () => {
    const s = setup(b)
    s.store.putJson.mockImplementation(async (key, value) => { if (key === ledgerKey) throw new Error('ledger quota'); s.values.set(key, structuredClone(value)) })
    await s.apply(frame({ ...binding, scope: 'everyone', verified: true, localIntent: true }))
    await s.engine['persist']()
    expect(s.engine['state'].pendingMeDeletions?.[0].bindings).toEqual([binding])
    expect(s.ledger()).toBeUndefined()
    const recovered = setup(b); for (const [key, value] of s.values) recovered.values.set(key, structuredClone(value))
    Object.assign(recovered.engine['state'], structuredClone(s.values.get('app')))
    recovered.engine['connection'] = 'online'; await recovered.engine['flushMeDeletionSync']()
    expect(meDeletionBindings(recovered.ledger())).toEqual([binding])
    expect(recovered.engine['state'].pendingMeDeletions).toEqual([])
    expect(await recovered.engine.messages(conversation)).toEqual([])
    expect(recovered.ledger().records[0].localIntent).toBeUndefined()
  })

  it('journals an unknown own sender while the directory is held and revalidates after a crash', async () => {
    const s = setup(b), inbox = 'me-deletion-inbox:' + me
    const held = deferred<Awaited<ReturnType<typeof api.devices>>>(), entered = deferred<void>()
    const directory = { devices: [{ device_id: a }, { device_id: b }] } as Awaited<ReturnType<typeof api.devices>>
    vi.spyOn(api, 'devices').mockImplementation(async () => { entered.resolve(); return held.promise })
    s.engine['state'].myDevices = [b]; s.engine['connection'] = 'online'
    s.store.putJson.mockImplementation(async (key, value) => { if (key === 'app') throw new Error('crash after consumed ratchet'); s.values.set(key, structuredClone(value)) })
    await s.apply(frame({ ...binding, scope: 'everyone', verified: true, localIntent: true }))
    await entered.promise
    expect(s.engine['pendingSyncs']).toHaveLength(1)
    expect(s.ledger()).toBeUndefined()
    await expect(s.engine['persist']()).rejects.toThrow('crash after consumed ratchet')
    expect(s.values.get(inbox)).toEqual([{ conversationId: selfId, device: a, bindings: [binding] }])
    expect(s.store.putBytes).toHaveBeenCalled()
    expect(s.store.putJson.mock.invocationCallOrder[s.store.putJson.mock.calls.findIndex(([key]) => key === inbox)]).toBeLessThan(s.store.putBytes.mock.invocationCallOrder[0])
    s.engine['endingSession'] = true; s.engine['draftEpoch']++; held.resolve(directory); await s.engine['syncChain']
    const recovered = setup(b); for (const [key, value] of s.values) recovered.values.set(key, structuredClone(value))
    recovered.engine['state'].myDevices = [a, b]; recovered.engine['connection'] = 'online'
    recovered.engine['meDirectorySession'] = undefined
    await recovered.engine['loadMeDeletionInbox'](); await recovered.engine['flushMeDeletionSync']()
    expect(recovered.engine['pendingSyncs']).toEqual([])
    expect(meDeletionBindings(await recovered.engine['readDeletions']())).toEqual([])
    expect(recovered.engine['state'].pendingMeDeletions?.[0].bindings).toEqual([binding])
    vi.mocked(api.devices).mockResolvedValue(directory)
    vi.spyOn(api, 'devicesOf').mockResolvedValue({ devices: { [peer]: ['44'.repeat(16)] } })
    recovered.engine['reconcileDevices'] = vi.fn(async () => {})
    await recovered.engine['runSync']()
    expect(meDeletionBindings(recovered.ledger())).toEqual([binding])
    expect(recovered.values.get(inbox)).toEqual([])
    expect(await recovered.engine.messages(conversation)).toEqual([])
  })

  it('journals decrypted incoming bindings before the consumed ratchet when ledger and app writes fail', async () => {
    const s = setup(b), inbox = 'me-deletion-inbox:' + me
    s.store.putJson.mockImplementation(async (key, value) => { if (key === ledgerKey || key === 'app') throw new Error('quota'); s.values.set(key, structuredClone(value)) })
    await s.apply(frame(binding))
    await expect(s.engine['persist']()).rejects.toThrow('quota')
    expect(s.values.get(inbox)).toEqual([{ conversationId: selfId, device: a, bindings: [binding] }])
    expect(s.store.putBytes).toHaveBeenCalled()
    const recovered = setup(b); for (const [key, value] of s.values) recovered.values.set(key, structuredClone(value))
    await recovered.engine['loadMeDeletionInbox']()
    recovered.engine['connection'] = 'online'; await recovered.engine['flushMeDeletionSync']()
    expect(meDeletionBindings(recovered.ledger())).toEqual([binding])
    expect(recovered.values.get(inbox)).toEqual([])
    expect(await recovered.engine.messages(conversation)).toEqual([])
  })

  it('does not persist a consumed ratchet when both ledger and incoming retry journal are unavailable', async () => {
    const s = setup(b), inbox = 'me-deletion-inbox:' + me
    s.store.putJson.mockImplementation(async (key, value) => { if (key === ledgerKey || key === inbox) throw new Error('quota'); s.values.set(key, structuredClone(value)) })
    await s.apply(frame(binding))
    await expect(s.engine['persist']()).rejects.toThrow('quota')
    expect(s.store.putBytes).not.toHaveBeenCalled()
    expect(s.engine['state'].pendingMeDeletions?.[0].bindings).toEqual([binding])
  })

  it('restores Native producer bindings and blocks matching heartbeats despite a history read failure', async () => {
    const s = setup(b), other = '92'.repeat(16), otherHash = 'bb'.repeat(32), point = { latitude: 48, longitude: 2, accuracyM: 10 }
    vi.spyOn(maps, 'prepareArea').mockImplementation(() => {})
    const liveCore = Object.assign(s.core, { lastSentContentHash: fromHex(hash), sendLiveLocation: vi.fn(() => new Uint8Array([1])) })
    s.engine['scheduleLiveSweep'] = vi.fn()
    s.engine['state'].conversations[other] = { id: other, peers: [peer], lastAt: 0 }
    s.rosters.set(other, [makeIdentity(me, b), makeIdentity(peer, '44'.repeat(16))])
    await s.engine.startLive(conversation, null, point)
    liveCore.lastSentContentHash = fromHex(otherHash)
    await s.engine.startLive(other, null, point)
    const first = structuredClone(s.engine['state'].live[0]), second = structuredClone(s.engine['state'].live[1])
    expect(first.binding).toEqual({ hash, author: me, at: 1_000_100 })
    expect(second.binding).toEqual({ hash: otherHash, author: me, at: 1_000_101 })
    s.engine['state'].outbox = []; await s.engine['persist']()
    const recovered = setup(b); for (const [key, value] of s.values) recovered.values.set(key, structuredClone(value))
    Object.assign(recovered.engine['state'], structuredClone(s.values.get('app')))
    const sendLiveLocation = vi.fn<CoreClient['sendLiveLocation']>(() => new Uint8Array([1]))
    Object.assign(recovered.core, { sendLiveLocation, lastSentContentHash: fromHex('cc'.repeat(32)) })
    recovered.rosters.set(other, [makeIdentity(me, b), makeIdentity(peer, '44'.repeat(16))])
    expect(recovered.engine['deletionKnown'].size).toBe(0)
    let historyUnavailable = true
    recovered.store.getJson.mockImplementation(async (key) => { if (key === historyKey && historyUnavailable) throw new Error('history unavailable'); return structuredClone(recovered.values.get(key)) })
    await recovered.apply(frame({ ...binding, author: me }))
    expect(recovered.ledger().records[0].target).toBe('')
    expect(recovered.ledger().records[0].liveSession).toBeUndefined()
    expect(recovered.engine['state'].live.map((l) => l.sessionId)).toEqual([second.sessionId])
    const view = recovered.engine.view()
    expect(view.phase === 'ready' && view.liveSharing.map((l) => l.conversationId)).toEqual([other])
    recovered.engine['connection'] = 'online'
    vi.setSystemTime(1_060_102); await recovered.engine.liveUpdate(point)
    expect(sendLiveLocation).toHaveBeenCalledTimes(1)
    expect(sendLiveLocation.mock.calls[0][0]).toEqual(fromHex(other))
    historyUnavailable = false
    expect((await recovered.engine.messages(conversation)).some((m) => m.id === first.messageId)).toBe(false)
    vi.setSystemTime(1_120_103); await recovered.engine.liveUpdate(point)
    expect(sendLiveLocation).toHaveBeenCalledTimes(2)
    expect(sendLiveLocation.mock.calls.every((call) => String(call[1]) !== String(fromHex(first.sessionId)))).toBe(true)
    expect(recovered.engine['state'].live[0].binding?.hash).toBe(otherHash)
  })

  it('stops a matching own live producer on another device without stopping an unrelated producer', async () => {
    const s = setup(b), sessionId = '91'.repeat(16)
    s.values.set(historyKey, [{ ...original, from: 'me', live: { sessionId, expiresAt: 2_000_000 } }])
    s.engine['state'].live = [{ conversationId: conversation, messageId: target, sessionId, expiresAt: 2_000_000, lastSentAt: 0 }, { conversationId: '92'.repeat(16), messageId: '93'.repeat(16), sessionId: '94'.repeat(16), expiresAt: 2_000_000, lastSentAt: 0 }]
    await s.engine.messages(conversation)
    await s.apply(frame({ ...binding, author: me }))
    expect(s.engine['state'].live).toHaveLength(1)
    expect(s.engine['state'].live[0].conversationId).toBe('92'.repeat(16))
    expect(await s.engine.messages(conversation)).toEqual([])
  })

  it('invalidates loaded aliases even if history reads and physical cleanup fail after own-device acceptance', async () => {
    const s = setup(b); await s.engine.messages(conversation)
    s.store.getJson.mockImplementation(async (key) => { if (key === historyKey) throw new Error('history unavailable'); return structuredClone(s.values.get(key)) })
    await s.apply(frame(binding))
    expect(s.ledger().records[0].aliases).toEqual([target])
    expect(s.events.some((event) => event.type === 'messages' && event.deletions?.some((d) => d.messageId === target && d.scope === 'me'))).toBe(true)
  })
})

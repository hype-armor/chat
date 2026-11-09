/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { CoreClient, initSync } from './pkg/chat_core.js'
import { SecureStore } from './storage'
import { fromHex, makeIdentity } from './ids'
import { DELETE_WINDOW_MS, type DeletionLedger } from './deletions'
import { api } from './api'
import * as transfers from './transfers'
import * as attachments from './attachments'
import { deriveBackupKeys, openBackup } from './backup'
import type { CoreEvent } from './protocol'

const me = '11'.repeat(16), device = '22'.repeat(16), peer = '33'.repeat(16), peerDevice = '44'.repeat(16)
const conversation = '55'.repeat(16), target = '66'.repeat(16), hash = 'aa'.repeat(32), at = 10_000_000
const identity = makeIdentity(me, device), sender = makeIdentity(peer, peerDevice)
const original = { id: target, from: 'me', text: 'secret original', sentAt: at, status: 'sent' as const, contentHash: hash }
const ledgerKey = 'deletions:' + me, historyKey = 'messages:' + conversation, capsuleKey = 'hidden-send:' + conversation + ':' + target
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
function setup() {
  const events: CoreEvent[] = []
  const engine = new Engine((event) => events.push(event))
  const values = new Map<string, unknown>([[historyKey, [structuredClone(original)]]])
  const files = new Map<string, Blob>()
  const account = { accountId: me, deviceId: device, username: 'me', displayName: 'Me', token: 'synthetic' }
  const core = { identity: () => identity, members: () => [identity, sender, makeIdentity(me, '77'.repeat(16))], snapshot: vi.fn(() => new Uint8Array([2])),
    sendDeletion: vi.fn<CoreClient['sendDeletion']>(() => new Uint8Array([3])), sendText: vi.fn(() => new Uint8Array([4])), sendAttachment: vi.fn(() => new Uint8Array([5])), lastSentContentHash: fromHex(hash) }
  const store = {
    getJson: vi.fn(async (key: string) => structuredClone(values.get(key))),
    putJson: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }),
    deleteBytes: vi.fn(async (key: string) => { values.delete(key) }),
    getBytes: vi.fn(async () => new Uint8Array([2])), putBytes: vi.fn(async () => {}),
    getFile: vi.fn(async (key: string) => files.get(key)), putFile: vi.fn(async (key: string, body: Blob | undefined) => { if (body) files.set(key, body); else files.delete(key) }),
    clear: vi.fn(async () => { values.clear(); files.clear() }), getKey: vi.fn(async () => undefined as CryptoKey | undefined),
  }
  engine['account'] = account
  engine['core'] = core as unknown as NonNullable<Engine['core']>
  engine['store'] = store as unknown as Engine['store']
  engine['state'].conversations[conversation] = { id: conversation, peers: [peer], lastAt: at, lastText: original.text }
  const flush = engine['flushOutbox'].bind(engine)
  engine['flushOutbox'] = vi.fn(async () => {})
  const apply = (options: { author?: string; from?: string; target?: string; hash?: string; requestAt?: number; device?: string } = {}) => engine['apply']({
    kind: 'message', conversationId: fromHex(conversation), sender: makeIdentity(options.from ?? peer, options.device ?? peerDevice),
    sentAtMs: options.requestAt ?? at + 1, deletionTarget: fromHex(options.target ?? target), deletionTargetHash: fromHex(options.hash ?? hash), deletionTargetAuthor: fromHex(options.author ?? peer),
  } as Parameters<Engine['apply']>[0], '88'.repeat(16))
  const ledger = () => values.get(ledgerKey) as DeletionLedger
  const rows = () => engine.messages(conversation)
  return { engine, events, values, files, account, core, store, flush, apply, ledger, rows }
}
beforeAll(() => initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) }))
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at + 100) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('worker message deletion', () => {
  it('hides legacy Me history offline without reply permission, membership, or a network send', async () => {
    const s = setup()
    s.values.set(historyKey, [{ ...original, contentHash: undefined, from: peer }])
    s.engine['state'].conversations[conversation].status = 'left'
    expect((await s.rows())[0]).toMatchObject({ canReply: false, canDeleteForMe: true, canDeleteForEveryone: false })
    await expect(s.engine.deleteMessage(conversation, target, 'me')).resolves.toEqual({ accepted: true, scope: 'me' })
    expect(await s.rows()).toEqual([])
    expect(s.core.sendDeletion).not.toHaveBeenCalled()
    expect(s.ledger().records[0]).toMatchObject({ scope: 'me', target })
    expect(JSON.stringify(s.values.get(historyKey))).not.toContain(original.text)
  })

  it('creates a minimal irreversible placeholder and strips bindings, keys, coordinates, replies, and reactions from UI', async () => {
    const s = setup()
    s.values.set(historyKey, [{ ...original, location: { latitude: 1, longitude: 2 }, replyTo: '99'.repeat(16), file: { key: 'secret-key', digest: 'digest', name: 'secret-name', mime: 'image/jpeg', size: 1 } }])
    await s.engine.deleteMessage(conversation, target, 'everyone')
    const [row] = await s.rows()
    expect(row).toMatchObject({ deleted: true, text: '', canReply: false, canReact: false, canDeleteForMe: true, canDeleteForEveryone: false, deletionStatus: { status: 'sending' } })
    for (const field of ['contentHash', 'reactionEvent', 'hidden', 'location', 'replyTo', 'reply', 'file']) expect(row[field as keyof typeof row]).toBeUndefined()
    expect(s.core.sendDeletion).toHaveBeenCalledWith(fromHex(conversation), fromHex(target), fromHex(hash), fromHex(me), at + 100, expect.any(Uint8Array))
    expect(s.ledger().records[0]).toMatchObject({ localIntent: true, originalAt: at, requestAt: at + 100, author: me, hash })
  })

  it.each(['blocked', 'request'] as const)('permits precise own Everyone deletion in a %s chat without enabling other activity', async (mode) => {
    const s = setup()
    if (mode === 'blocked') s.engine['state'].blocked.push(peer)
    else s.engine['state'].conversations[conversation].request = true
    expect((await s.rows())[0].canDeleteForEveryone).toBe(true)
    expect(s.engine['reactionAllowed'](conversation)).toBe(false)
    await s.engine.deleteMessage(conversation, target, 'everyone')
    expect(s.core.sendDeletion).toHaveBeenCalledTimes(1)
    expect(s.engine['receipts'].size).toBe(0)
  })

  it.each(['blocked', 'request'] as const)('honors authenticated received deletion in a %s chat', async (mode) => {
    const s = setup()
    s.values.set(historyKey, [{ ...original, from: peer }])
    if (mode === 'blocked') s.engine['state'].blocked.push(peer)
    else s.engine['state'].conversations[conversation].request = true
    await s.apply()
    expect((await s.rows())[0]).toMatchObject({ deleted: true })
    expect(s.ledger().records[0].localIntent).toBeUndefined()
    expect(s.engine['receipts'].size).toBe(0)
  })

  it('rejects ownership, legacy hashes, notices, removed membership, unsafe times, and postdeadline new intents', async () => {
    for (const change of [{ from: peer }, { contentHash: undefined }, { kind: 'notice' }, { sentAt: 0 }, { sentAt: at - DELETE_WINDOW_MS }, { sentAt: at + 2_101 }]) {
      const s = setup(); s.values.set(historyKey, [{ ...original, ...change }])
      await expect(s.engine.deleteMessage(conversation, target, 'everyone')).rejects.toThrow()
      expect(s.core.sendDeletion).not.toHaveBeenCalled()
      expect(s.ledger()).toBeUndefined()
    }
    const s = setup(); s.core.members = () => [sender]
    await expect(s.engine.deleteMessage(conversation, target, 'everyone')).rejects.toThrow()
    expect(s.ledger()).toBeUndefined()
  })

  it('does not extend the hour through a session wall-clock rollback', async () => {
    const s = setup()
    vi.setSystemTime(at + DELETE_WINDOW_MS + 1)
    expect((await s.rows())[0].canDeleteForEveryone).toBe(false)
    vi.setSystemTime(at + 10)
    expect((await s.rows())[0].canDeleteForEveryone).toBe(false)
    await expect(s.engine.deleteMessage(conversation, target, 'everyone')).rejects.toThrow()
  })

  it('does not redact for wrong account/hash/time or same-ID content, and binds renamed authentic copies', async () => {
    const s = setup(); s.values.set(historyKey, [{ ...original, from: peer }])
    await s.apply({ from: me, author: peer }); await s.apply({ hash: 'bb'.repeat(32) }); await s.apply({ requestAt: at - 1 }); await s.apply({ requestAt: at + DELETE_WINDOW_MS + 1 })
    expect((await s.rows())[0].deleted).not.toBe(true)
    await s.apply({ target: '99'.repeat(16) })
    expect((await s.rows())[0].deleted).toBe(true)
    await s.engine['appendMessage'](conversation, { ...original, id: '98'.repeat(16), from: peer })
    expect((await s.rows()).every((m) => m.deleted)).toBe(true)
    await s.engine['appendMessage'](conversation, { ...original, from: peer, contentHash: 'cc'.repeat(32) })
    expect((await s.rows()).at(-1)?.text).toBe(original.text)
  })

  it('holds out-of-order requests without redaction, then verifies and suppresses the first original write', async () => {
    const s = setup(); s.values.set(historyKey, [])
    await s.apply({ requestAt: at - 1 }); await s.apply()
    expect(s.ledger().records).toHaveLength(0)
    expect(s.ledger().candidates).toHaveLength(2)
    await s.engine['appendMessage'](conversation, { ...original, from: peer })
    expect(s.ledger().records).toHaveLength(1)
    expect((await s.rows())[0].deleted).toBe(true)
    expect(JSON.stringify(s.values.get(historyKey))).not.toContain(original.text)
  })

  it('leaves the original readable on first ledger failure', async () => {
    const s = setup(); s.store.putJson.mockImplementation(async (key, value) => { if (key === ledgerKey) throw new Error('quota'); s.values.set(key, structuredClone(value)) })
    await expect(s.engine.deleteMessage(conversation, target, 'everyone')).rejects.toThrow('quota')
    expect((await s.rows())[0].text).toBe(original.text)
    expect(s.core.sendDeletion).not.toHaveBeenCalled()
    expect(s.engine['state'].outbox).toHaveLength(0)
  })

  it('keeps accepted deletion and exposes retry when encryption fails', async () => {
    const s = setup(); s.core.sendDeletion.mockImplementation(() => { throw new Error('group unavailable') })
    await expect(s.engine.deleteMessage(conversation, target, 'everyone')).resolves.toMatchObject({ accepted: true })
    expect((await s.rows())[0]).toMatchObject({ deleted: true, deletionStatus: { status: 'failed' } })
    expect(s.engine['state'].outbox).toHaveLength(0)
  })

  it('retains the advanced ratchet and rejects transport when app persistence fails after local acceptance', async () => {
    const s = setup(); s.store.putJson.mockImplementation(async (key, value) => { if (key === 'app') throw new Error('quota'); s.values.set(key, structuredClone(value)) })
    await s.engine.deleteMessage(conversation, target, 'everyone')
    expect(s.store.putBytes).toHaveBeenCalledWith('core', new Uint8Array([2]))
    expect(s.engine['state'].outbox).toHaveLength(0)
    expect((await s.rows())[0]).toMatchObject({ deleted: true, deletionStatus: { status: 'failed' } })
    expect(s.ledger().records[0].requestAt).toBe(at + 100)
  })

  it('recovers a first-commit-only crash as unconfirmed and retries after the hour with the original accepted time', async () => {
    const s = setup(); s.core.sendDeletion.mockImplementation(() => { throw new Error('crash before encryption') })
    await s.engine.deleteMessage(conversation, target, 'everyone')
    const recovered = setup(); recovered.values.set(ledgerKey, structuredClone(s.store.putJson.mock.calls.find(([key]) => key === ledgerKey)![1]))
    vi.setSystemTime(at + DELETE_WINDOW_MS * 2)
    const [row] = await recovered.rows()
    expect(row).toMatchObject({ deleted: true, deletionStatus: { status: 'failed' } })
    await recovered.engine.retryDeletion(conversation, row.deletionStatus!.id)
    expect(recovered.core.sendDeletion.mock.calls[0][4]).toBe(at + 100)
    expect((await recovered.rows())[0].deletionStatus?.status).toBe('sending')
  })

  it('does not infer local retry authority from an incoming own-device deletion', async () => {
    const s = setup(); await s.apply({ from: me, author: me, device: '77'.repeat(16) })
    expect((await s.rows())[0]).toMatchObject({ deleted: true, deletionStatus: undefined })
    await expect(s.engine.retryDeletion(conversation, '88'.repeat(16))).rejects.toThrow('No accepted deletion intent')
  })

  it('projects unconfirmed transport failure, explicit retry, successful acknowledgement, and equivalent remote acceptance', async () => {
    const s = setup(); await s.engine.deleteMessage(conversation, target, 'everyone')
    s.engine['connection'] = 'online'; s.engine['request'] = vi.fn(async () => ({ errorCode: 400 } as Awaited<ReturnType<Engine['request']>>))
    await s.flush()
    const id = (await s.rows())[0].deletionStatus!.id
    expect((await s.rows())[0].deletionStatus).toMatchObject({ status: 'failed', error: expect.stringContaining('unconfirmed') })
    await s.engine.retryDeletion(conversation, id)
    s.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true } as Awaited<ReturnType<Engine['request']>>))
    await s.flush()
    expect((await s.rows())[0].deletionStatus).toBeUndefined()
    expect(s.ledger().records[0].acknowledged).toBe(true)
    await s.apply({ from: me, author: me, device: '77'.repeat(16) })
    expect((await s.rows())[0].deletionStatus).toBeUndefined()
  })

  it('does not shift the next envelope or restore an Everyone-deleted original after a late acknowledgement', async () => {
    const s = setup(), ack = deferred<Awaited<ReturnType<Engine['request']>>>()
    s.engine['state'].outbox.push({ conversationId: conversation, messageId: target, envelope: 'AQ==', recipients: [] })
    s.engine['connection'] = 'online'; s.engine['request'] = vi.fn(() => ack.promise)
    const flushing = s.flush()
    await s.engine.deleteMessage(conversation, target, 'everyone')
    const deletionId = s.engine['state'].outbox[0].messageId
    s.engine['connection'] = 'offline'; ack.resolve({ kind: 'send_result', accepted: true } as Awaited<ReturnType<Engine['request']>>); await flushing
    expect(s.engine['state'].outbox.map((o) => o.messageId)).toEqual([deletionId])
    expect((await s.rows())[0].deleted).toBe(true)
  })

  it('preserves an already queued original and hides Everyone retry status when deleted for Me', async () => {
    const s = setup()
    s.engine['state'].outbox.push({ conversationId: conversation, messageId: target, envelope: 'AQ==', recipients: [] })
    await s.engine.deleteMessage(conversation, target, 'me')
    expect(s.engine['state'].outbox.map((o) => o.messageId)).toContain(target)
    expect(await s.rows()).toEqual([])
    const other = setup(); await other.engine.deleteMessage(conversation, target, 'everyone'); const id = other.engine['state'].outbox[0].messageId
    await other.engine.deleteMessage(conversation, target, 'me')
    expect(await other.rows()).toEqual([])
    expect(other.engine['state'].outbox.map((o) => o.messageId)).toContain(id)
  })

  it('blocks reply/react/original retries while preserving composer text, revisions, and reply bodies', async () => {
    const s = setup()
    s.values.set(historyKey, [original, { ...original, id: '99'.repeat(16), contentHash: 'bb'.repeat(32), text: 'reply body', replyTo: target, replyToHash: hash }])
    s.values.set('draft:' + me + ':' + conversation, { text: 'keep draft', revision: 7 })
    await s.engine.deleteMessage(conversation, target, 'everyone')
    await expect(s.engine.sendText(conversation, 'new body', target)).rejects.toThrow('reply target')
    await expect(s.engine.react(conversation, target, '👍')).rejects.toThrow('unavailable')
    await s.engine.retryMessage(conversation, target)
    expect(s.core.sendText).not.toHaveBeenCalled()
    expect(s.values.get('draft:' + me + ':' + conversation)).toEqual({ text: 'keep draft', revision: 7 })
    expect((await s.rows())[1]).toMatchObject({ text: 'reply body', reply: { unavailable: true } })
  })

  it('fences queued deletion work when the lifecycle changes during a history read', async () => {
    const s = setup(), read = deferred<unknown>(), entered = deferred<void>()
    s.store.getJson.mockImplementation(async (key) => { if (key === historyKey) { entered.resolve(); return read.promise } return structuredClone(s.values.get(key)) })
    const pending = s.engine.deleteMessage(conversation, target, 'everyone')
    await entered.promise; s.engine['draftEpoch']++; read.resolve([original])
    await expect(pending).rejects.toThrow('session ended')
    expect(s.core.sendDeletion).not.toHaveBeenCalled()
    expect(s.ledger()).toBeUndefined()
  })

  it('stops only the matching local live producer and rejects later points that could recreate a deleted card', async () => {
    const s = setup(), sessionId = '99'.repeat(16)
    s.values.set(historyKey, [{ ...original, live: { sessionId, expiresAt: at + 100_000, untilStopped: true } }])
    s.engine['state'].live = [{ conversationId: conversation, sessionId, messageId: target, expiresAt: at + 100_000, lastSentAt: at }, { conversationId: '88'.repeat(16), sessionId: '77'.repeat(16), messageId: 'aa'.repeat(16), expiresAt: at + 100_000, lastSentAt: at }]
    await s.engine.deleteMessage(conversation, target, 'me')
    expect(s.engine['state'].live).toHaveLength(1)
    const free = vi.fn()
    await s.engine['applyLive'](conversation, me, true, '98'.repeat(16), at + 100, { sessionId: fromHex(sessionId), location: { latitude: 1, longitude: 2, accuracyM: 1, free }, expiresAtMs: at + 100_000 } as unknown as Parameters<Engine['applyLive']>[5])
    expect(free).toHaveBeenCalled()
    expect(await s.rows()).toEqual([])
  })

  it('retains only a minimal pending Me upload capsule and purges it on permanent failure', async () => {
    const s = setup()
    s.values.set(historyKey, [{ ...original, status: 'sending', contentHash: undefined, file: { name: 'photo', mime: 'image/jpeg', size: 1, key: 'key', digest: 'digest', thumbnail: 'thumbnail', width: 300, downloaded: true } }])
    s.files.set(target, new Blob(['sealed']))
    s.engine['state'].transfers.push({ conversationId: conversation, messageId: target, kind: 'upload' })
    await s.engine.deleteMessage(conversation, target, 'me')
    expect(await s.rows()).toEqual([])
    const capsule = s.values.get(capsuleKey)
    expect(capsule).toMatchObject({ text: original.text, file: { key: 'key' } })
    for (const field of ['contentHash', 'from', 'status', 'id', 'thumbnail', 'downloaded']) expect(JSON.stringify(capsule)).not.toContain('"' + field + '"')
    const keys = await deriveBackupKeys(new Uint8Array(16)); s.store.getKey.mockResolvedValue(keys.encryption); s.engine['state'].backup = {}
    const uploadBackup = vi.spyOn(api, 'uploadBackup').mockResolvedValue(new Uint8Array())
    await s.engine.backupNow()
    const payload = await openBackup<Record<string, unknown>>(keys.encryption, uploadBackup.mock.calls[0][1])
    expect(JSON.stringify(payload)).not.toContain(original.text)
    expect(JSON.stringify(payload)).not.toContain('thumbnail')
    expect(JSON.stringify(payload)).not.toContain('hidden-send')
    s.engine['connection'] = 'online'
    vi.spyOn(transfers, 'upload').mockRejectedValue(new Error('permanent upload failure'))
    await s.engine['uploadAndSend'](conversation, target)
    expect(s.values.has(capsuleKey)).toBe(false)
    expect(s.files.has(target)).toBe(false)
    expect(await s.rows()).toEqual([])
  })

  it('discovers and removes a pre-tombstone capsule orphan on restart without recalling the accepted upload', async () => {
    const s = setup(), index = 'hidden-send-index:' + me
    s.values.set(historyKey, [{ ...original, status: 'sending', contentHash: undefined, file: { name: 'photo', mime: 'image/jpeg', size: 1, key: 'AA==', digest: 'AA==' } }])
    s.files.set(target, new Blob(['sealed'])); s.engine['state'].transfers.push({ conversationId: conversation, messageId: target, kind: 'upload' })
    s.values.set('account', s.account); await s.engine['persist']()
    s.store.putJson.mockImplementation(async (key, value) => { if (key === ledgerKey) throw new Error('crash before tombstone'); s.values.set(key, structuredClone(value)) })
    s.store.deleteBytes.mockRejectedValue(new Error('crashed before rollback'))
    await expect(s.engine.deleteMessage(conversation, target, 'me')).rejects.toThrow('crash before tombstone')
    expect(s.values.has(capsuleKey)).toBe(true)
    const recovered = setup(); for (const [key, value] of s.values) recovered.values.set(key, structuredClone(value)); for (const [key, body] of s.files) recovered.files.set(key, body)
    vi.spyOn(CoreClient, 'restore').mockReturnValue(recovered.core as unknown as CoreClient)
    vi.spyOn(SecureStore, 'open').mockResolvedValue(recovered.store as unknown as SecureStore)
    vi.stubGlobal('self', { addEventListener: vi.fn() }); recovered.engine['connect'] = vi.fn()
    await recovered.engine.start()
    expect(recovered.values.has(capsuleKey)).toBe(false)
    expect(recovered.values.get(index)).toEqual([])
    expect(recovered.store.deleteBytes).toHaveBeenCalledWith(capsuleKey)
    expect((await recovered.rows())[0].text).toBe(original.text)
    expect(recovered.engine['state'].transfers).toHaveLength(1)
    expect(recovered.files.has(target)).toBe(true)
    expect(s.values.get(index)).toEqual([{ conversationId: conversation, messageId: target }])
    const writes = s.store.putJson.mock.calls.map(([key]) => key)
    expect(writes.indexOf(index)).toBeLessThan(writes.indexOf(capsuleKey))
    expect(writes.indexOf(capsuleKey)).toBeLessThan(writes.indexOf(ledgerKey))
  })

  it('cleans a capsule after failed rollback and successful ordinary transport settlement without a tombstone', async () => {
    const s = setup(), index = 'hidden-send-index:' + me
    s.values.set(historyKey, [{ ...original, status: 'sending', contentHash: undefined, file: { name: 'photo', mime: 'image/jpeg', size: 1, key: 'AA==', digest: 'AA==' } }])
    s.files.set(target, new Blob(['sealed'])); s.engine['state'].transfers.push({ conversationId: conversation, messageId: target, kind: 'upload' })
    s.store.putJson.mockImplementation(async (key, value) => { if (key === ledgerKey) throw new Error('quota'); s.values.set(key, structuredClone(value)) })
    let deletionUnavailable = true
    s.store.deleteBytes.mockImplementation(async (key) => { if (deletionUnavailable) throw new Error('cleanup unavailable'); s.values.delete(key) })
    await expect(s.engine.deleteMessage(conversation, target, 'me')).rejects.toThrow('quota')
    expect(s.values.has(capsuleKey)).toBe(true); expect(s.ledger()).toBeUndefined()
    vi.spyOn(transfers, 'upload').mockResolvedValue('12345678-1234-1234-1234-123456789012')
    await s.engine['uploadAndSend'](conversation, target)
    expect(s.core.sendAttachment).toHaveBeenCalledTimes(1)
    expect(s.values.has(capsuleKey)).toBe(true)
    deletionUnavailable = false
    s.engine['connection'] = 'online'; s.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true } as Awaited<ReturnType<Engine['request']>>))
    await s.flush()
    expect(s.values.has(capsuleKey)).toBe(false)
    expect(s.values.get(index)).toEqual([])
    expect(s.store.deleteBytes).toHaveBeenCalledWith(capsuleKey)
    expect((await s.rows())[0]).toMatchObject({ text: original.text, status: 'sent' })
    expect(s.ledger()).toBeUndefined()
  })

  it('retries orphan capsule deletion while offline without keeping an unneeded archive until restart', async () => {
    const s = setup()
    s.values.set(historyKey, [{ ...original, status: 'sending', file: { name: 'photo', mime: 'image/jpeg', size: 1, key: 'AA==', digest: 'AA==' } }])
    s.engine['state'].transfers.push({ conversationId: conversation, messageId: target, kind: 'upload' })
    s.store.putJson.mockImplementation(async (key, value) => { if (key === ledgerKey) throw new Error('quota'); s.values.set(key, structuredClone(value)) })
    s.store.deleteBytes.mockRejectedValue(new Error('temporary deletion failure'))
    await expect(s.engine.deleteMessage(conversation, target, 'me')).rejects.toThrow('quota')
    expect(s.values.has(capsuleKey)).toBe(true)
    s.store.deleteBytes.mockImplementation(async (key) => { s.values.delete(key) })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(s.values.has(capsuleKey)).toBe(false)
    expect(s.values.get('hidden-send-index:' + me)).toEqual([])
    expect(s.engine['state'].transfers).toHaveLength(1)
    expect((await s.rows())[0].text).toBe(original.text)
    expect(s.engine['hiddenSendCleanupTimer']).toBeUndefined()
  })

  it('continues an accepted Me upload without restoring its row and purges its capsule after settlement', async () => {
    const s = setup()
    s.values.set(historyKey, [{ ...original, status: 'sending', contentHash: undefined, file: { name: 'photo', mime: 'image/jpeg', size: 1, key: 'AA==', digest: 'AA==' } }])
    s.files.set(target, new Blob(['sealed'])); s.engine['state'].transfers.push({ conversationId: conversation, messageId: target, kind: 'upload' })
    await s.engine.deleteMessage(conversation, target, 'me')
    vi.spyOn(transfers, 'upload').mockResolvedValue('12345678-1234-1234-1234-123456789012')
    await s.engine['uploadAndSend'](conversation, target)
    expect(s.core.sendAttachment).toHaveBeenCalledTimes(1)
    expect(s.engine['state'].outbox.map((o) => o.messageId)).toContain(target)
    expect(await s.rows()).toEqual([])
    s.engine['connection'] = 'online'; s.engine['request'] = vi.fn(async () => ({ kind: 'send_result', accepted: true } as Awaited<ReturnType<Engine['request']>>))
    await s.flush()
    expect(s.values.has(capsuleKey)).toBe(false)
    expect(s.files.has(target)).toBe(false)
  })

  it.each(['everyone cancellation', 'account reset'] as const)('purges a pending Me capsule on %s', async (mode) => {
    const s = setup()
    s.values.set(historyKey, [{ ...original, status: 'sending', file: { name: 'file', mime: 'image/jpeg', size: 1, key: 'key', digest: 'digest' } }])
    s.files.set(target, new Blob(['sealed'])); s.engine['state'].transfers.push({ conversationId: conversation, messageId: target, kind: 'upload' })
    await s.engine.deleteMessage(conversation, target, 'me')
    expect(s.values.has(capsuleKey)).toBe(true)
    if (mode === 'everyone cancellation') await s.apply({ author: me, from: me, device: '77'.repeat(16) })
    else await s.engine['signOut']('reset')
    expect(s.values.has(capsuleKey)).toBe(false)
    expect(s.files.has(target)).toBe(false)
    expect(s.engine['state'].transfers).toHaveLength(0)
  })

  it('fences late cache reads and downloads after a tombstone', async () => {
    const s = setup(), kept = deferred<Blob | undefined>(), entered = deferred<void>()
    s.values.set(historyKey, [{ ...original, file: { name: 'file', mime: 'application/octet-stream', size: 1, blobId: '12'.repeat(16), key: 'AA==', digest: 'AA==' } }])
    s.store.getFile.mockImplementation(async () => { entered.resolve(); return kept.promise })
    const opened = s.engine.openAttachment(conversation, target)
    await entered.promise; await s.engine.deleteMessage(conversation, target, 'everyone'); kept.resolve(new Blob(['sealed']))
    await expect(opened).rejects.toThrow('deleted')
    expect(s.files.has(target)).toBe(false)
  })

  it('emits ID-only verified invalidations before failed cleanup and includes authentic aliases, never candidate IDs', async () => {
    const s = setup(), alias = '99'.repeat(16)
    s.values.set(historyKey, [{ ...original, from: peer }, { ...original, id: alias, from: peer }])
    await s.apply({ hash: 'bb'.repeat(32) })
    expect(s.events.filter((e) => e.type === 'messages' && e.deletions?.length)).toEqual([])
    s.store.putJson.mockImplementation(async (key, value) => { if (key === historyKey) throw new Error('cleanup failed'); s.values.set(key, structuredClone(value)) })
    await s.apply({ target: '98'.repeat(16) })
    const invalidations = s.events.filter((e) => e.type === 'messages' && e.deletions?.length)
    expect(invalidations).toHaveLength(1)
    expect(invalidations[0]).toEqual({ type: 'messages', conversationId: conversation, deletions: [{ messageId: target, scope: 'everyone' }, { messageId: alias, scope: 'everyone' }] })
    expect(s.ledger().records[0].aliases).toEqual([target, alias])
    expect((await s.rows()).every((m) => m.deleted)).toBe(true)
  })

  it('keeps deletion transport gated through a paused ratchet persistence write', async () => {
    const s = setup(), gate = deferred<void>(), entered = deferred<void>()
    s.store.putBytes.mockImplementation(async () => { entered.resolve(); await gate.promise })
    s.engine['connection'] = 'online'; s.engine['request'] = vi.fn()
    const deletion = s.engine.deleteMessage(conversation, target, 'everyone')
    await entered.promise
    await s.flush()
    expect(s.engine['request']).not.toHaveBeenCalled()
    gate.resolve(); await deletion
    expect(s.ledger().records[0].localIntent).toBe(true)
  })

  it('prevents delayed download chunks from entering the cache after acceptance', async () => {
    const s = setup(), gate = deferred<void>(), entered = deferred<void>()
    s.values.set(historyKey, [{ ...original, file: { name: 'file', mime: 'application/octet-stream', size: 1, blobId: '12'.repeat(16), key: 'AA==', digest: 'AA==' } }])
    vi.spyOn(transfers, 'download').mockImplementation(async (_token, _blob, _size, guarded) => {
      entered.resolve(); await gate.promise
      const body = new Blob(['sealed']); await guarded.putFile(target + '#0', body); return body
    })
    const opened = s.engine.openAttachment(conversation, target)
    await entered.promise; await s.engine.deleteMessage(conversation, target, 'everyone'); gate.resolve()
    await expect(opened).rejects.toThrow('deleted')
    expect(s.files.size).toBe(0)
  })

  it('rejects decrypted bytes that complete after acceptance', async () => {
    const s = setup(), gate = deferred<Blob>(), entered = deferred<void>()
    s.values.set(historyKey, [{ ...original, file: { name: 'file', mime: 'application/octet-stream', size: 1, blobId: '12'.repeat(16), key: 'AA==', digest: 'AA==' } }])
    s.files.set(target, new Blob(['sealed']))
    vi.spyOn(attachments, 'openFile').mockImplementation(async () => { entered.resolve(); return gate.promise })
    const opened = s.engine.openAttachment(conversation, target)
    await entered.promise; await s.engine.deleteMessage(conversation, target, 'everyone'); gate.resolve(new Blob(['plaintext']))
    await expect(opened).rejects.toThrow('deleted')
    expect(s.files.size).toBe(0)
  })

  it('redacts initial ready views and backups after a crash with old history/app previews and cleanup failure', async () => {
    const first = setup(); first.core.sendDeletion.mockImplementation(() => { throw new Error('crash') }); await first.engine.deleteMessage(conversation, target, 'everyone')
    const s = setup(); s.values.set(ledgerKey, structuredClone(first.ledger()))
    s.values.set('account', s.account); s.values.set('app', { ...s.engine['state'], conversations: { [conversation]: { ...s.engine['state'].conversations[conversation], lastText: original.text } } })
    s.store.putJson.mockImplementation(async (key, value) => { if (key === historyKey) throw new Error('cleanup quota'); s.values.set(key, structuredClone(value)) })
    vi.spyOn(CoreClient, 'restore').mockReturnValue(s.core as unknown as CoreClient)
    vi.spyOn(SecureStore, 'open').mockResolvedValue(s.store as unknown as SecureStore)
    vi.stubGlobal('self', { addEventListener: vi.fn() }); s.engine['connect'] = vi.fn()
    await s.engine.start()
    const views = s.events.filter((e) => e.type === 'view')
    expect(views.length).toBeGreaterThan(0)
    expect(JSON.stringify(views)).not.toContain(original.text)
    expect((await s.rows())[0]).toMatchObject({ deleted: true, text: '' })
    const keys = await deriveBackupKeys(new Uint8Array(16)); s.store.getKey.mockResolvedValue(keys.encryption); s.engine['state'].backup = {}
    const upload = vi.spyOn(api, 'uploadBackup').mockResolvedValue(new Uint8Array())
    await s.engine.backupNow()
    const payload = await openBackup<Record<string, unknown>>(keys.encryption, upload.mock.calls[0][1])
    expect(JSON.stringify(payload)).not.toContain(original.text)
    expect(payload.deletions).toBeDefined()
    expect(JSON.stringify(payload)).not.toContain('hidden-send')
  })
})

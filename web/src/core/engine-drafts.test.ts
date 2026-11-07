import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { fromHex, makeIdentity } from './ids'
import type { CoreEvent } from './protocol'
import * as backup from './backup'
import { api } from './api'
import * as attachments from './attachments'

const account = '11'.repeat(16)
const device = '22'.repeat(16)
const peer = '33'.repeat(16)
const peerDevice = '44'.repeat(16)
const first = '55'.repeat(16)
const second = '56'.repeat(16)
const draftKey = (id = first) => `draft:${account}:${id}`

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function setup(values = new Map<string, unknown>()) {
  vi.spyOn(attachments, 'sealFile').mockResolvedValue({ body: new Blob(['sealed']), size: 4, digest: new Uint8Array(32) })
  const events: CoreEvent[] = []
  const engine = new Engine((event) => events.push(event))
  const me = makeIdentity(account, device)
  const sender = makeIdentity(peer, peerDevice)
  const sendDeviceSync = vi.fn(() => new Uint8Array([5]))
  engine['account'] = { accountId: account, deviceId: device, username: 'me', displayName: 'Me', token: '' }
  engine['core'] = {
    identity: () => me,
    members: () => [me, sender],
    sendText: vi.fn(() => new Uint8Array([1])),
    lastSentContentHash: fromHex('aa'.repeat(32)),
    snapshot: () => new Uint8Array([2]),
    leave: vi.fn(() => new Uint8Array([3])),
    isActive: () => false,
    sendDeviceSync,
  } as unknown as NonNullable<Engine['core']>
  for (const id of [first, second]) engine['state'].conversations[id] = { id, peers: [peer], lastAt: 0 }
  engine['state'] = { ...engine['state'], ...structuredClone(values.get('app') ?? {}) }
  engine['store'] = {
    getJson: vi.fn(async (key: string) => structuredClone(values.get(key))),
    putJson: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }),
    putBytes: vi.fn(async () => {}),
    putFile: vi.fn(async (id: string, body?: Blob) => {
      if (body) values.set(`file:${id}`, body)
      else values.delete(`file:${id}`)
    }),
    deleteBytes: vi.fn(async (key: string) => { values.delete(key) }),
    clear: vi.fn(async () => { values.clear() }),
    getKey: vi.fn(async () => ({} as CryptoKey)),
  } as unknown as Engine['store']
  engine['flushOutbox'] = vi.fn(async () => {})
  engine['uploadAndSend'] = vi.fn(async () => {})
  engine['scheduleSync'] = vi.fn()
  return { engine, values, events, sendDeviceSync }
}

afterEach(() => vi.restoreAllMocks())

describe('device-local text drafts', () => {
  it('preserves exact text across conversations and a reconstructed engine', async () => {
    const { engine, values } = setup()
    await expect(engine.getDraft(first)).resolves.toEqual({ text: '', revision: 0 })
    await engine.saveDraft(first, '  First\n\n', 0)
    await engine.saveDraft(second, 'Second', 0)
    expect(values.get(draftKey())).toEqual({ text: '  First\n\n', revision: 1 })
    const restarted = setup(values).engine
    await expect(restarted.getDraft(first)).resolves.toEqual({ text: '  First\n\n', revision: 1 })
    await expect(restarted.getDraft(second)).resolves.toEqual({ text: 'Second', revision: 1 })
    expect(values.has('app')).toBe(false)
  })

  it('advances identical and empty saves and rejects stale revisions without replacing text', async () => {
    const { engine, events } = setup()
    await engine.saveDraft(first, 'same', 0)
    await expect(engine.saveDraft(first, 'same', 1)).resolves.toEqual({ applied: true, draft: { text: 'same', revision: 2 } })
    await expect(engine.saveDraft(first, 'stale', 1)).resolves.toEqual({ applied: false, draft: { text: 'same', revision: 2 } })
    await engine.saveDraft(first, '', 2)
    await expect(engine.saveDraft(first, '', 3)).resolves.toEqual({ applied: true, draft: { text: '', revision: 4 } })
    expect(events.filter((event) => event.type === 'draft')).toHaveLength(4)
  })

  it('serializes reads with saves so that a delayed restore cannot become the next CAS base', async () => {
    const { engine } = setup()
    const gate = deferred()
    const original = vi.mocked(engine['store'].putJson).getMockImplementation()!
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => { await gate.promise; await original(key, value) })
    const saving = engine.saveDraft(first, 'typed', 0)
    const reading = engine.getDraft(first)
    const staleSave = engine.saveDraft(first, 'stale', 0)
    gate.resolve()
    await saving
    await expect(reading).resolves.toEqual({ text: 'typed', revision: 1 })
    await expect(staleSave).resolves.toEqual({ applied: false, draft: { text: 'typed', revision: 1 } })
  })

  it('does not announce or replace a draft when its save fails', async () => {
    const { engine, events } = setup()
    await engine.saveDraft(first, 'retained', 0)
    vi.mocked(engine['store'].putJson).mockRejectedValueOnce(new Error('quota'))
    await expect(engine.saveDraft(first, 'keep in UI', 1)).rejects.toThrow('quota')
    await expect(engine.getDraft(first)).resolves.toEqual({ text: 'retained', revision: 1 })
    expect(events.filter((event) => event.type === 'draft')).toHaveLength(1)
    await expect(engine.saveDraft(first, 'keep in UI', 1)).resolves.toMatchObject({ applied: true })
  })

  it('atomically accepts the outbox and clearing fence, and retains the fence across restart', async () => {
    const { engine, values, events } = setup()
    await engine.saveDraft(first, '  send me\n', 0)
    const gate = deferred()
    const started = deferred()
    const original = vi.mocked(engine['store'].putJson).getMockImplementation()!
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => {
      if (key === 'app') { started.resolve(); await gate.promise }
      await original(key, value)
    })
    const sending = engine.sendText(first, 'send me', undefined, 1)
    await started.promise
    expect(events.filter((event) => event.type === 'draft')).toHaveLength(1)
    expect(values.has('app')).toBe(false)
    expect(engine['flushOutbox']).not.toHaveBeenCalled()
    const request = vi.fn<Engine['request']>(async () => undefined)
    engine['request'] = request
    engine['connection'] = 'online'
    await Engine.prototype['flushOutbox'].call(engine)
    expect(request).not.toHaveBeenCalled()
    gate.resolve()
    await expect(sending).resolves.toEqual({ draft: { text: '', revision: 2 }, consumedRevision: 2 })
    expect(values.get('app')).toMatchObject({ outbox: [expect.objectContaining({ conversationId: first })], draftClears: { [first]: 2 } })
    expect(engine['store'].deleteBytes).toHaveBeenCalledWith(draftKey())
    await expect(setup(values).engine.getDraft(first)).resolves.toEqual({ text: '', revision: 2 })
    await expect(engine.saveDraft(first, 'stale recreation', 1)).resolves.toEqual({ applied: false, draft: { text: '', revision: 2 } })
    await expect(engine.saveDraft(first, 'send me', 2)).resolves.toEqual({ applied: true, draft: { text: 'send me', revision: 3 } })
  })

  it('retains an identical newer draft and never consumes another chat', async () => {
    const { engine } = setup()
    await engine.saveDraft(first, 'same', 0)
    await engine.saveDraft(first, 'same', 1)
    await engine.saveDraft(second, 'same', 0)
    await expect(engine.sendText(first, 'same', undefined, 1)).resolves.toEqual({ draft: { text: 'same', revision: 2 } })
    await expect(engine.getDraft(first)).resolves.toEqual({ text: 'same', revision: 2 })
    await expect(engine.getDraft(second)).resolves.toEqual({ text: 'same', revision: 1 })
    await engine.sendText(first, 'different', undefined, 2)
    await expect(engine.getDraft(first)).resolves.toEqual({ text: 'same', revision: 2 })
    await engine.sendText(first, 'same')
    await expect(engine.getDraft(first)).resolves.toEqual({ text: 'same', revision: 2 })
  })

  it.each(['text', 'file'] as const)('does not claim consumption for an unrelated empty revision on a %s send', async (kind) => {
    const { engine } = setup()
    vi.spyOn(attachments, 'prepareImage').mockResolvedValue(undefined)
    await engine.saveDraft(first, 'caption', 0)
    // Another writer wins revision 2 before the submitted revision 1 reaches acceptance.
    await engine.saveDraft(first, '', 1)
    await expect(engine.saveDraft(first, 'conflicting local edit', 1)).resolves.toEqual({ applied: false, draft: { text: '', revision: 2 } })
    const result = kind === 'text'
      ? await engine.sendText(first, 'caption', undefined, 1)
      : await engine.sendFile(first, new File(['body'], 'note.txt'), 'caption', undefined, 1)
    expect(result).toEqual({ draft: { text: '', revision: 2 } })
    expect(result).not.toHaveProperty('consumedRevision')
    expect(engine['state'].draftClears).toEqual({})
    await expect(engine.saveDraft(first, 'conflicting local edit', 1)).resolves.toMatchObject({ applied: false })
    // Only an explicit retry can adopt the unrelated revision as its CAS base.
    await expect(engine.saveDraft(first, 'conflicting local edit', 2)).resolves.toEqual({ applied: true, draft: { text: 'conflicting local edit', revision: 3 } })
  })

  it('keeps the previous draft visible if app acceptance fails', async () => {
    const { engine, events } = setup()
    await engine.saveDraft(first, 'send me', 0)
    const original = vi.mocked(engine['store'].putJson).getMockImplementation()!
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => {
      if (key === 'app') throw new Error('app transaction aborted')
      await original(key, value)
    })
    await expect(engine.sendText(first, 'send me', undefined, 1)).rejects.toThrow('app transaction aborted')
    await expect(engine.getDraft(first)).resolves.toEqual({ text: 'send me', revision: 1 })
    expect(engine['state'].draftClears).toEqual({})
    expect(events.filter((event) => event.type === 'draft')).toHaveLength(1)
    expect(engine['store'].deleteBytes).not.toHaveBeenCalled()
  })

  it('never flushes a rejected text envelope after a later successful persist', async () => {
    const { engine, values } = setup()
    await engine.saveDraft(first, 'rejected', 0)
    const core = engine['core']
    const original = vi.mocked(engine['store'].putJson).getMockImplementation()!
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => {
      if (key === 'app') throw new Error('app transaction aborted')
      await original(key, value)
    })
    await expect(engine.sendText(first, 'rejected', undefined, 1)).rejects.toThrow('app transaction aborted')
    expect(engine['state'].outbox).toEqual([])
    expect(await engine['stored'](first)).toMatchObject([{ text: 'rejected', status: 'failed' }])
    expect(engine['core']).toBe(core)
    expect(core!.sendText).toHaveBeenCalledTimes(1)
    vi.mocked(engine['store'].putJson).mockImplementation(original)
    await engine['exclusive'](() => engine['persist']())
    expect(values.get('app')).toMatchObject({ outbox: [], draftClears: {} })
    const request = vi.fn<Engine['request']>(async () => undefined)
    engine['request'] = request
    engine['connection'] = 'online'
    await Engine.prototype['flushOutbox'].call(engine)
    expect(request).not.toHaveBeenCalled()
    await expect(engine.getDraft(first)).resolves.toEqual({ text: 'rejected', revision: 1 })
    const restarted = setup(values).engine
    await expect(restarted.messages(first)).resolves.toMatchObject([{ text: 'rejected', status: 'failed' }])
  })

  it('accepts a durable send even if stale encrypted-record cleanup fails', async () => {
    const { engine, values } = setup()
    await engine.saveDraft(first, 'send me', 0)
    vi.mocked(engine['store'].deleteBytes).mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(engine.sendText(first, 'send me', undefined, 1)).resolves.toEqual({ draft: { text: '', revision: 2 }, consumedRevision: 2 })
    expect(values.get(draftKey())).toEqual({ text: 'send me', revision: 1 })
    await expect(setup(values).engine.getDraft(first)).resolves.toEqual({ text: '', revision: 2 })
  })

  it('does not consume a revision when the send is rejected before acceptance', async () => {
    const { engine } = setup()
    await engine.saveDraft(first, 'send me', 0)
    engine['state'].conversations[first].status = 'left'
    await expect(engine.sendText(first, 'send me', undefined, 1)).rejects.toThrow('no longer')
    expect(engine['state'].draftClears).toEqual({})
    expect(engine['store'].deleteBytes).not.toHaveBeenCalled()
  })

  it('accepts a caption with its upload-resume entry before remote upload finishes', async () => {
    const { engine, values } = setup()
    vi.spyOn(attachments, 'prepareImage').mockResolvedValue(undefined)
    const upload = deferred()
    vi.mocked(engine['uploadAndSend']).mockImplementation(() => upload.promise)
    await engine.saveDraft(first, '  caption\n', 0)
    await expect(engine.sendFile(first, new File(['body'], 'note.txt'), 'caption', undefined, 1)).resolves.toEqual({ draft: { text: '', revision: 2 }, consumedRevision: 2 })
    expect(values.get('app')).toMatchObject({ transfers: [expect.objectContaining({ conversationId: first, kind: 'upload' })], draftClears: { [first]: 2 } })
    await expect(setup(values).engine.getDraft(first)).resolves.toEqual({ text: '', revision: 2 })
    await engine.saveDraft(first, 'new text', 2)
    upload.resolve()
    await Promise.resolve()
    await expect(engine.getDraft(first)).resolves.toEqual({ text: 'new text', revision: 3 })
  })

  it('does not consume identical new text after delayed attachment preparation', async () => {
    const { engine } = setup()
    const preparing = deferred()
    const started = deferred()
    vi.spyOn(attachments, 'prepareImage').mockImplementation(async () => { started.resolve(); await preparing.promise; return undefined })
    await engine.saveDraft(first, 'caption', 0)
    const sending = engine.sendFile(first, new File(['body'], 'note.txt'), 'caption', undefined, 1)
    await started.promise
    await engine.saveDraft(first, 'caption', 1)
    preparing.resolve()
    await expect(sending).resolves.toEqual({ draft: { text: 'caption', revision: 2 } })
    await expect(engine.getDraft(first)).resolves.toEqual({ text: 'caption', revision: 2 })
    expect(engine['state'].draftClears).toEqual({})
  })

  it('retains the caption and rejects attachment acceptance when app persistence fails', async () => {
    const { engine, values } = setup()
    vi.spyOn(attachments, 'prepareImage').mockResolvedValue(undefined)
    await engine.saveDraft(first, 'caption', 0)
    const original = vi.mocked(engine['store'].putJson).getMockImplementation()!
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => {
      if (key === 'app') throw new Error('app transaction aborted')
      await original(key, value)
    })
    await expect(engine.sendFile(first, new File(['body'], 'note.txt'), 'caption', undefined, 1)).rejects.toThrow('app transaction aborted')
    await expect(engine.getDraft(first)).resolves.toEqual({ text: 'caption', revision: 1 })
    const history = await engine['stored'](first)
    expect(history).toMatchObject([{ text: 'caption', status: 'failed', error: expect.stringContaining('Not accepted') }])
    expect(values.get(`file:${history[0].id}`)).toBeInstanceOf(Blob)
    const restarted = setup(values).engine
    await expect(restarted.messages(first)).resolves.toMatchObject([{ text: 'caption', status: 'failed' }])
    await expect(restarted.getDraft(first)).resolves.toEqual({ text: 'caption', revision: 1 })
    expect(engine['state'].transfers).toEqual([])
    expect(engine['state'].draftClears).toEqual({})
    expect(engine['uploadAndSend']).not.toHaveBeenCalled()
  })

  it('recovers an orphan sending attachment after failed acceptance and failed status cleanup', async () => {
    const { engine, values } = setup()
    vi.spyOn(attachments, 'prepareImage').mockResolvedValue(undefined)
    await engine.saveDraft(first, 'caption', 0)
    const original = vi.mocked(engine['store'].putJson).getMockImplementation()!
    let historyWrites = 0
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => {
      if (key === 'app') throw new Error('app transaction aborted')
      if (key === `messages:${first}` && ++historyWrites > 1) throw new Error('status cleanup failed')
      await original(key, value)
    })
    await expect(engine.sendFile(first, new File(['body'], 'note.txt'), 'caption', undefined, 1)).rejects.toThrow('app transaction aborted')
    expect(await engine['stored'](first)).toMatchObject([{ status: 'sending' }])
    const restarted = setup(values).engine
    const recovered = await restarted.messages(first)
    expect(await restarted['stored'](first)).toMatchObject([{ status: 'failed' }])
    expect(recovered).toMatchObject([{ status: 'failed', error: expect.stringContaining('Not accepted') }])
    expect(values.get(`file:${recovered[0].id}`)).toBeInstanceOf(Blob)
    expect(restarted['state'].transfers).toEqual([])
    await expect(restarted.getDraft(first)).resolves.toEqual({ text: 'caption', revision: 1 })
  })

  it('keeps accepted outbox and upload-resume cards sending during restart recovery', async () => {
    const { engine, values } = setup()
    vi.spyOn(attachments, 'prepareImage').mockResolvedValue(undefined)
    await engine.sendText(first, 'accepted text')
    await engine.sendFile(second, new File(['body'], 'note.txt'), 'accepted caption')
    const restarted = setup(values).engine
    await expect(restarted.messages(first)).resolves.toMatchObject([{ text: 'accepted text', status: 'sending' }])
    await expect(restarted.messages(second)).resolves.toMatchObject([{ text: 'accepted caption', status: 'sending' }])
    expect(restarted['state'].outbox).toHaveLength(1)
    expect(restarted['state'].transfers).toHaveLength(1)
  })

  it('recovers only the loaded conversation without reading unrelated history', async () => {
    const { engine, values } = setup()
    const orphan = { id: 'aa'.repeat(16), from: 'me', text: 'orphan', sentAt: 1, status: 'sending' }
    values.set(`messages:${first}`, [orphan])
    values.set(`messages:${second}`, [{ ...orphan, text: 'unrelated orphan' }])
    await expect(engine.messages(first)).resolves.toMatchObject([{ text: 'orphan', status: 'failed' }])
    expect(engine['store'].getJson).toHaveBeenCalledExactlyOnceWith(`messages:${first}`)
    expect(values.get(`messages:${second}`)).toMatchObject([{ text: 'unrelated orphan', status: 'sending' }])
  })

  it('returns readable history and logical failed status when recovery persistence fails', async () => {
    const { engine, values } = setup()
    const orphan = { id: 'aa'.repeat(16), from: 'me', text: 'orphan', sentAt: 1, status: 'sending' }
    const received = { id: 'bb'.repeat(16), from: peer, text: 'readable history', sentAt: 2, status: 'received' }
    values.set(`messages:${first}`, [orphan, received])
    vi.mocked(engine['store'].putJson).mockRejectedValue(new Error('storage full'))
    await expect(engine.messages(first)).resolves.toMatchObject([
      { text: 'orphan', status: 'failed', error: expect.stringContaining('Not accepted') },
      { text: 'readable history', status: 'received' },
    ])
    // The durable history remains unchanged. Each load can derive the safe display status again.
    expect(values.get(`messages:${first}`)).toMatchObject([{ status: 'sending' }, { status: 'received' }])
    await expect(engine.messages(first)).resolves.toMatchObject([{ status: 'failed' }, { status: 'received' }])
    expect(engine['store'].putJson).toHaveBeenCalledTimes(2)
  })

  it.each(['text', 'file'] as const)('does not recover a provisional %s send while acceptance is pending', async (kind) => {
    const { engine } = setup()
    vi.spyOn(attachments, 'prepareImage').mockResolvedValue(undefined)
    const gate = deferred()
    const started = deferred()
    const original = vi.mocked(engine['store'].putJson).getMockImplementation()!
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => {
      if (key === 'app') { started.resolve(); await gate.promise }
      await original(key, value)
    })
    const sending = kind === 'text'
      ? engine.sendText(first, 'accepted')
      : engine.sendFile(first, new File(['body'], 'note.txt'), 'accepted')
    await started.promise
    let loaded = false
    const reading = engine.messages(first).then((list) => { loaded = true; return list })
    await Promise.resolve()
    await Promise.resolve()
    expect(loaded).toBe(false)
    gate.resolve()
    await sending
    await expect(reading).resolves.toMatchObject([{ text: 'accepted', status: 'sending' }])
    expect(await engine['stored'](first)).toMatchObject([{ status: 'sending' }])
  })

  it('removes the sealed body if attachment history could not be stored', async () => {
    const { engine, values } = setup()
    vi.spyOn(attachments, 'prepareImage').mockResolvedValue(undefined)
    await engine.saveDraft(first, 'caption', 0)
    vi.mocked(engine['store'].putJson).mockRejectedValueOnce(new Error('history transaction aborted'))
    await expect(engine.sendFile(first, new File(['body'], 'note.txt'), 'caption', undefined, 1)).rejects.toThrow('history transaction aborted')
    expect(engine['store'].putFile).toHaveBeenCalledTimes(2)
    expect([...values.keys()].some((key) => key.startsWith('file:'))).toBe(false)
    expect(await engine['stored'](first)).toEqual([])
    expect(engine['state'].transfers).toEqual([])
  })

  it('does not recreate local records when attachment preparation finishes after reset', async () => {
    const { engine, values } = setup()
    const preparing = deferred()
    const started = deferred()
    vi.spyOn(attachments, 'prepareImage').mockImplementation(async () => { started.resolve(); await preparing.promise; return undefined })
    await engine.saveDraft(first, 'caption', 0)
    const sending = engine.sendFile(first, new File(['body'], 'note.txt'), 'caption', undefined, 1)
    const rejected = expect(sending).rejects.toThrow('session ended')
    await started.promise
    await engine['signOut']('Reset')
    preparing.resolve()
    await rejected
    expect(values.size).toBe(0)
    expect(engine['store'].putFile).not.toHaveBeenCalled()
    expect(engine['uploadAndSend']).not.toHaveBeenCalled()
  })

  it('invalidates a draft on leave and rejects subsequent writes', async () => {
    const { engine, values } = setup()
    await engine.saveDraft(first, 'leave draft', 0)
    await engine.leaveGroup(first)
    await expect(engine.getDraft(first)).resolves.toEqual({ text: '', revision: 2 })
    await expect(engine.saveDraft(first, 'must not return', 1)).rejects.toThrow('cannot accept')
    expect(values.get('app')).toMatchObject({ draftClears: { [first]: 2 } })
  })

  it('invalidates drafts on a removal commit', async () => {
    const { engine } = setup()
    await engine.saveDraft(first, 'removed draft', 0)
    await engine['exclusive'](async () => {
      await engine['apply']({ kind: 'epoch', conversationId: fromHex(first) } as Parameters<Engine['apply']>[0], 'ff'.repeat(16))
      await engine['persist']()
    })
    await expect(engine.getDraft(first)).resolves.toEqual({ text: '', revision: 2 })
    await expect(engine.saveDraft(first, 'must not return', 1)).rejects.toThrow('cannot accept')
  })

  it('clears after an in-flight write and rejects queued writes during account reset', async () => {
    const { engine, values } = setup()
    const gate = deferred()
    const started = deferred()
    const original = vi.mocked(engine['store'].putJson).getMockImplementation()!
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => {
      started.resolve(); await gate.promise; await original(key, value)
    })
    const saving = engine.saveDraft(first, 'in flight', 0)
    const savingRejected = expect(saving).rejects.toThrow('session ended')
    await started.promise
    const queued = engine.saveDraft(second, 'queued', 0)
    const queuedRejected = expect(queued).rejects.toThrow('session ended')
    const reset = engine['signOut']('Reset')
    gate.resolve()
    await Promise.all([savingRejected, queuedRejected, reset])
    expect(values.size).toBe(0)
    await expect(engine.getDraft(first)).rejects.toThrow('not signed in')
  })

  it('excludes draft text and fences from backup blobs, device sync, and public views', async () => {
    const { engine, sendDeviceSync } = setup()
    await engine.saveDraft(first, 'LOCAL DRAFT SECRET', 0)
    engine['state'].draftClears[second] = 42
    engine['state'].backup = {}
    const sealing = vi.spyOn(backup, 'sealBackup').mockResolvedValue(new Uint8Array([9]))
    vi.spyOn(api, 'uploadBackup').mockResolvedValue(new Uint8Array())
    await engine.backupNow()
    const payload = sealing.mock.calls[0][1]
    expect(JSON.stringify(payload)).not.toContain('LOCAL DRAFT SECRET')
    expect(JSON.stringify(payload)).not.toContain('draftClears')
    engine['queueDeviceSync'](first)
    const bytes = sendDeviceSync.mock.calls[0] as unknown as [Uint8Array, Uint8Array]
    const sync = new TextDecoder().decode(bytes[1])
    expect(sync).not.toContain('LOCAL DRAFT SECRET')
    expect(sync).not.toContain('draftClears')
    expect(JSON.stringify(engine.view())).not.toContain('LOCAL DRAFT SECRET')
  })

  it('rejects invalid revisions and prototype-shaped or unknown conversations', async () => {
    const { engine } = setup()
    for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(engine.saveDraft(first, 'text', revision)).rejects.toThrow('Invalid draft revision')
    }
    for (const id of ['unknown', '__proto__', 'constructor']) {
      await expect(engine.getDraft(id)).rejects.toThrow('not found')
      await expect(engine.saveDraft(id, 'text', 0)).rejects.toThrow('cannot accept')
    }
  })
})

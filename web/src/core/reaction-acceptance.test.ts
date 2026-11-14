import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { makeIdentity } from './ids'
import { MAX_SEND_RETRIES } from './commits'

const me = '11'.repeat(16), device = '22'.repeat(16), peer = '33'.repeat(16)
const id = '55'.repeat(16), target = '66'.repeat(16), hash = 'aa'.repeat(32)
const original = { id: target, from: peer, text: 'Original', sentAt: 1, status: 'received' as const, contentHash: hash }
function setup() {
  const engine = new Engine(() => {})
  const values = new Map<string, unknown>([['messages:' + id, [structuredClone(original)]]])
  const sendReaction = vi.fn(() => new Uint8Array([1]))
  engine['account'] = { accountId: me, deviceId: device, username: 'me', displayName: 'Me', token: '' }
  engine['core'] = { identity: () => makeIdentity(me, device), members: () => [makeIdentity(me, device), makeIdentity(peer, '44'.repeat(16))], sendReaction, snapshot: () => new Uint8Array([2]) } as unknown as NonNullable<Engine['core']>
  engine['state'].conversations[id] = { id, peers: [peer], lastAt: 1 }
  engine['store'] = { getJson: async (key: string) => structuredClone(values.get(key)), putJson: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }), putBytes: vi.fn(async () => {}), clear: vi.fn(async () => { values.clear() }) } as unknown as Engine['store']
  engine['flushOutbox'] = vi.fn(async () => {})
  const request = vi.fn<Engine['request']>(async () => undefined)
  engine['request'] = request
  engine['connection'] = 'online'
  const flush = () => Engine.prototype['flushOutbox'].call(engine)
  const message = async () => (await engine.messages(id))[0]
  return { engine, values, sendReaction, request, flush, message }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const result = (fields: Record<string, unknown>) => fields as unknown as Awaited<ReturnType<Engine['request']>>
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('reaction durable acceptance', () => {
  it.each(['history', 'app'] as const)('gates concurrent transport through delayed %s acceptance', async (stage) => {
    const { engine, request, flush } = setup()
    const started = deferred(), gate = deferred()
    const put = vi.mocked(engine['store'].putJson).getMockImplementation()!
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => {
      if (key === (stage === 'history' ? 'messages:' + id : 'app')) { started.resolve(); await gate.promise }
      await put(key, value)
    })
    const sending = engine.react(id, target, '👍')
    await started.promise
    expect(engine['state'].outbox).toHaveLength(1)
    await flush()
    await flush()
    expect(request).not.toHaveBeenCalled()
    gate.resolve()
    await sending
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
    expect(engine['acceptingReactions'].size).toBe(0)
  })

  it.each(['history', 'app', 'core'] as const)('never sends a rejected update after failed %s persistence or a later successful persist', async (stage) => {
    const { engine, values, request, flush, sendReaction, message } = setup()
    const core = engine['core']
    const started = deferred(), gate = deferred()
    const put = vi.mocked(engine['store'].putJson).getMockImplementation()!
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => {
      if (key === (stage === 'history' ? 'messages:' + id : stage === 'app' ? 'app' : 'never')) {
        started.resolve(); await gate.promise; throw new Error('quota')
      }
      await put(key, value)
    })
    const putBytes = vi.mocked(engine['store'].putBytes).getMockImplementation()!
    if (stage === 'core') vi.mocked(engine['store'].putBytes).mockImplementation(async () => { started.resolve(); await gate.promise; throw new Error('quota') })
    const sending = engine.react(id, target, '👍').then(() => undefined, (error: unknown) => error)
    await started.promise
    await flush()
    expect(request).not.toHaveBeenCalled()
    gate.resolve()
    expect(await sending).toBeInstanceOf(Error)
    expect(engine['state'].outbox).toEqual([])
    expect(engine['core']).toBe(core)
    expect(sendReaction).toHaveBeenCalledTimes(1)
    expect(engine['store'].putBytes).toHaveBeenCalledWith('core', new Uint8Array([2]))
    vi.mocked(engine['store'].putJson).mockImplementation(put)
    vi.mocked(engine['store'].putBytes).mockImplementation(putBytes)
    await engine['exclusive'](() => engine['persist']())
    await flush()
    expect(request).not.toHaveBeenCalled()
    expect(values.get('app')).toMatchObject({ outbox: [] })
    const visible = await message()
    if (stage !== 'history') expect(visible.reactionStatus?.status).toBe('failed')
    else expect(visible.reactions).toEqual([])
  })

  it.each([400, 503])('exposes failure and explicit retry for rejection/exhaustion code %s', async (code) => {
    const { engine, request, flush, message } = setup()
    await engine.react(id, target, '👍')
    expect((await message()).reactionStatus?.status).toBe('sending')
    const oldId = engine['state'].outbox[0].messageId
    if (code === 503) engine['state'].outbox[0].attempts = MAX_SEND_RETRIES
    request.mockResolvedValue(result({ kind: 'error', errorCode: code }))
    await flush()
    expect(engine['state'].outbox).toEqual([])
    expect((await message()).reactionStatus).toMatchObject({ id: oldId, status: 'failed' })
    await engine.retryMessage(id, oldId)
    const next = await message()
    expect(next.reactionStatus?.status).toBe('sending')
    expect(next.reactionStatus?.id).not.toBe(oldId)
    request.mockResolvedValue(result({ kind: 'send_result', accepted: true }))
    await flush()
    expect((await message()).reactionStatus).toBeUndefined()
    expect((await message()).reactions).toEqual([{ emoji: '👍', count: 1, own: true }])
    expect((await engine['stored'](id)).filter((m) => m.reactionEvent)).toHaveLength(2)
  })

  it('does not undo a newer edit when an older in-flight edit fails, and rejects stale retry', async () => {
    const { engine, request, flush, message } = setup()
    await engine.react(id, target, '👍')
    const oldId = engine['state'].outbox[0].messageId
    const started = deferred(), gate = deferred()
    request.mockImplementationOnce(async () => { started.resolve(); await gate.promise; return result({ kind: 'error', errorCode: 400 }) })
    const flushing = flush()
    await started.promise
    await engine.react(id, target, '❤️')
    gate.resolve()
    await flushing
    expect((await message()).reactions).toEqual([{ emoji: '❤️', count: 1, own: true }])
    expect((await message()).reactionStatus?.status).toBe('sending')
    await expect(engine.retryMessage(id, oldId)).rejects.toThrow('newer reaction')
  })

  it('retains failed removal ordering across reload and retry', async () => {
    const { engine, request, flush, message, values } = setup()
    await engine.react(id, target, '👍')
    request.mockResolvedValue(result({ kind: 'send_result', accepted: true }))
    await flush()
    await engine.react(id, target, '👍')
    request.mockResolvedValue(result({ kind: 'error', errorCode: 400 }))
    await flush()
    const failed = (await message()).reactionStatus!
    expect((await message()).reactions).toEqual([])
    const reloaded = setup()
    reloaded.values.set('messages:' + id, structuredClone(values.get('messages:' + id)))
    expect((await reloaded.message()).reactionStatus?.status).toBe('failed')
    await reloaded.engine.retryMessage(id, failed.id)
    expect((await reloaded.message()).reactions).toEqual([])
    expect((await reloaded.message()).reactionStatus?.status).toBe('sending')
  })

  it('allows mixed-group sends and removals but rejects blocked 1:1 sends', async () => {
    const { engine } = setup()
    engine['state'].blocked = [peer]
    expect((await engine.messages(id))[0].canReact).toBe(false)
    await expect(engine.react(id, target, '👍')).rejects.toThrow('unavailable')
    engine['state'].conversations[id].peers.push('77'.repeat(16))
    expect((await engine.messages(id))[0].canReact).toBe(true)
    expect(engine.view()).toMatchObject({ phase: 'ready', conversations: [{ id, isGroup: true, blocked: false }] })
    await expect(engine.react(id, target, '👍')).resolves.toBeUndefined()
    await expect(engine.react(id, target, '👍')).resolves.toBeUndefined()
    // A rename alone must not bypass a blocked direct chat.
    engine['state'].conversations[id].peers = [peer]
    engine['state'].conversations[id].name = 'Group'
    await expect(engine.react(id, target, '❤️')).rejects.toThrow('unavailable')
    // A real named group retains its admin list when only 1 peer remains.
    engine['state'].conversations[id].admins = [me]
    expect(engine.view()).toMatchObject({ phase: 'ready', conversations: [{ id, isGroup: true, blocked: false }] })
    await expect(engine.react(id, target, '❤️')).resolves.toBeUndefined()
  })

  it('marks an existing own chip and retry as blocked after a direct-chat rename and block', async () => {
    const { engine, message } = setup()
    await engine.react(id, target, '👍')
    const updateId = engine['state'].outbox[0].messageId
    engine['state'].outbox = []
    await engine['setStatus'](id, updateId, 'failed', 'Refused')
    engine['state'].conversations[id].name = 'Renamed direct chat'
    engine['state'].blocked = [peer]
    expect(engine.view()).toMatchObject({ phase: 'ready', conversations: [{ id, isGroup: false, blocked: true, peer }] })
    expect(await message()).toMatchObject({ canReact: false, reactions: [{ emoji: '👍', count: 1, own: true }], reactionStatus: { status: 'failed' } })
    await expect(engine.react(id, target, '👍')).rejects.toThrow('unavailable')
    await expect(engine.retryMessage(id, updateId)).rejects.toThrow('unavailable')
  })

  it.each(['react', 'retry'] as const)('rejects a queued %s RPC when sign-out invalidates its epoch', async (action) => {
    const { engine, sendReaction, request, flush } = setup()
    let failedId = ''
    if (action === 'retry') {
      await engine.react(id, target, '👍')
      failedId = engine['state'].outbox[0].messageId
      engine['state'].outbox = []
      await engine['setStatus'](id, failedId, 'failed', 'Refused')
    }
    sendReaction.mockClear()
    const entered = deferred(), gate = deferred()
    const holding = engine['exclusive'](async () => { entered.resolve(); await gate.promise })
    await entered.promise
    const rpc = action === 'react' ? engine.react(id, target, '❤️') : engine.retryMessage(id, failedId)
    const rejected = expect(rpc).rejects.toThrow('session ended')
    const reset = engine['signOut']('Reset')
    await flush()
    expect(request).not.toHaveBeenCalled()
    gate.resolve()
    await holding
    await rejected
    await reset
    expect(sendReaction).not.toHaveBeenCalled()
    expect(engine['state'].outbox).toEqual([])
  })

  it.each(['react', 'retry'] as const)('rejects %s after an in-flight original-history read crosses sign-out', async (action) => {
    const { engine, sendReaction, request, flush } = setup()
    let failedId = ''
    if (action === 'retry') {
      await engine.react(id, target, '👍')
      failedId = engine['state'].outbox[0].messageId
      engine['state'].outbox = []
      await engine['setStatus'](id, failedId, 'failed', 'Refused')
    }
    sendReaction.mockClear()
    const started = deferred(), gate = deferred()
    const get = engine['store'].getJson.bind(engine['store'])
    vi.spyOn(engine['store'], 'getJson').mockImplementation(async (key) => {
      const value = await get(key)
      if (key === 'messages:' + id) { started.resolve(); await gate.promise }
      return value
    })
    const rpc = action === 'react' ? engine.react(id, target, '❤️') : engine.retryMessage(id, failedId)
    const rejected = expect(rpc).rejects.toThrow('session ended')
    await started.promise
    const reset = engine['signOut']('Reset')
    await flush()
    gate.resolve()
    await rejected
    await reset
    expect(sendReaction).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([['react', 'history'], ['react', 'app'], ['react', 'core'], ['retry', 'history'], ['retry', 'app'], ['retry', 'core']] as const)('rejects in-flight %s %s acceptance after sign-out and never transports its advanced ratchet', async (action, stage) => {
    const { engine, sendReaction, request, flush } = setup()
    let failedId = ''
    if (action === 'retry') {
      await engine.react(id, target, '👍')
      failedId = engine['state'].outbox[0].messageId
      engine['state'].outbox = []
      await engine['setStatus'](id, failedId, 'failed', 'Refused')
    }
    sendReaction.mockClear()
    const started = deferred(), gate = deferred()
    const put = vi.mocked(engine['store'].putJson).getMockImplementation()!
    vi.mocked(engine['store'].putJson).mockImplementation(async (key, value) => {
      if (key === (stage === 'history' ? 'messages:' + id : stage === 'app' ? 'app' : 'never')) { started.resolve(); await gate.promise }
      await put(key, value)
    })
    if (stage === 'core') vi.mocked(engine['store'].putBytes).mockImplementation(async () => { started.resolve(); await gate.promise })
    const rpc = action === 'react' ? engine.react(id, target, '👍') : engine.retryMessage(id, failedId)
    const rejected = expect(rpc).rejects.toThrow('session ended')
    await started.promise
    const reset = engine['signOut']('Reset')
    await flush()
    expect(request).not.toHaveBeenCalled()
    gate.resolve()
    await rejected
    await reset
    expect(sendReaction).toHaveBeenCalledTimes(1)
    expect(engine['store'].putBytes).toHaveBeenCalledWith('core', new Uint8Array([2]))
    expect(engine['state'].outbox).toEqual([])
    expect(engine['acceptingReactions'].size).toBe(0)
    expect(request).not.toHaveBeenCalled()
  })

  it.each([me, '99'.repeat(16)])('cannot use a captured old core when queued registration replaces account %s', async (nextAccount) => {
    const { engine, sendReaction } = setup()
    const started = deferred(), gate = deferred()
    const holding = engine['exclusive'](async () => { started.resolve(); await gate.promise })
    await started.promise
    const nextSend = vi.fn()
    // Simulate register's account/core replacement and epoch increment under its mutation lock.
    const registration = engine['exclusive'](async () => {
      engine['draftEpoch']++
      engine['account'] = { ...engine['account']!, accountId: nextAccount }
      engine['core'] = { ...engine['core'], sendReaction: nextSend } as unknown as NonNullable<Engine['core']>
    })
    const rpc = engine.react(id, target, '👍')
    const rejected = expect(rpc).rejects.toThrow('session ended')
    gate.resolve()
    await holding
    await registration
    await rejected
    expect(sendReaction).not.toHaveBeenCalled()
    expect(nextSend).not.toHaveBeenCalled()
  })

  it('does not settle a transmitted old-session response into a replacement account outbox', async () => {
    const { engine, request, flush } = setup()
    await engine.react(id, target, '👍')
    const started = deferred(), gate = deferred()
    request.mockImplementationOnce(async () => { started.resolve(); await gate.promise; return result({ kind: 'send_result', accepted: true }) })
    const sending = flush()
    await started.promise
    await engine['signOut']('Reset')
    engine['draftEpoch']++
    engine['endingSession'] = false
    engine['account'] = { accountId: '99'.repeat(16), deviceId: device, username: 'new', displayName: 'New', token: '' }
    const replacement = { messageId: '88'.repeat(16), conversationId: id, envelope: '', recipients: [] }
    engine['state'].outbox.push(replacement)
    gate.resolve()
    await sending
    expect(engine['state'].outbox).toEqual([replacement])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['response', 'timeout'] as const)('hands blocked replacement-session work off after an old %s without another send', async (completion) => {
    const { engine, request, flush } = setup()
    await engine.react(id, target, '👍')
    const started = deferred(), gate = deferred()
    request.mockImplementationOnce(async () => {
      started.resolve(); await gate.promise
      return completion === 'response' ? result({ kind: 'send_result', accepted: true }) : undefined
    }).mockResolvedValue(result({ kind: 'send_result', accepted: true }))
    const sending = flush()
    await started.promise
    await engine['signOut']('Reset')
    engine['draftEpoch']++
    engine['endingSession'] = false
    engine['account'] = { accountId: '99'.repeat(16), deviceId: device, username: 'new', displayName: 'New', token: '' }
    engine['core'] = { snapshot: () => new Uint8Array([9]) } as unknown as NonNullable<Engine['core']>
    engine['connection'] = 'online'
    engine['state'].outbox.push({ messageId: '88'.repeat(16), conversationId: id, envelope: '', recipients: [] })
    engine['flushOutbox'] = Engine.prototype['flushOutbox'].bind(engine)
    // Model the new session's auth flush while the old run still owns the flag.
    await engine['flushOutbox']()
    expect(request).toHaveBeenCalledTimes(1)
    gate.resolve()
    await sending
    await expect.poll(() => engine['state'].outbox.length).toBe(0)
    expect(request).toHaveBeenCalledTimes(2)
    expect(engine['account'].accountId).toBe('99'.repeat(16))
  })

  it('does not turn same-session lost responses or backoff into a flush loop', async () => {
    vi.useFakeTimers()
    const { engine, request, flush } = setup()
    await engine.react(id, target, '👍')
    engine['flushOutbox'] = Engine.prototype['flushOutbox'].bind(engine)
    await flush()
    expect(request).toHaveBeenCalledTimes(1)
    expect(engine['state'].outbox).toHaveLength(1)
    request.mockResolvedValue(result({ kind: 'error', errorCode: 503 }))
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(engine['state'].outbox[0].attempts).toBe(1)
    expect(engine['flushing']).toBe(false)
    vi.clearAllTimers()
  })

  it('keeps history readable if derived verification evidence cannot persist', async () => {
    const { engine, values, message } = setup()
    const update = { target, hash, author: peer, emoji: '👍', account: me, device, at: 10 }
    values.set('messages:' + id, [original, { id: '', from: '', kind: 'notice', text: '', sentAt: 10, status: 'received', reactionEvent: update }])
    vi.mocked(engine['store'].putJson).mockRejectedValue(new Error('quota'))
    expect(await message()).toMatchObject({ text: 'Original', reactions: [{ emoji: '👍', count: 1, own: true }] })
    // The failed derived write must not manufacture durable removal authorization.
    values.set('messages:' + id, [{ ...original, contentHash: undefined }, { id: '', from: '', kind: 'notice', text: '', sentAt: 10, status: 'received', reactionEvent: update }])
    expect((await message()).reactions).toEqual([])
    await expect(engine.react(id, target, '👍')).rejects.toThrow('cannot be verified')
  })
})

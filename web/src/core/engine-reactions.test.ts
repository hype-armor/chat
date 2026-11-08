import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { fromHex, makeIdentity } from './ids'
import { api } from './api'
import { deriveBackupKeys, openBackup } from './backup'
import { newer, type ReactionUpdate } from './reactions'

const me = '11'.repeat(16), device = '22'.repeat(16), peer = '33'.repeat(16), peerDevice = '44'.repeat(16)
const id = '55'.repeat(16), target = '66'.repeat(16), hash = 'aa'.repeat(32)
const identity = makeIdentity(me, device), sender = makeIdentity(peer, peerDevice)
const original = { id: target, from: peer, text: 'Original', sentAt: 1, status: 'received' as const, contentHash: hash }
function setup() {
  const engine = new Engine(() => {})
  const values = new Map<string, unknown>([['messages:' + id, [structuredClone(original)]]])
  const sendReaction = vi.fn(() => new Uint8Array([1]))
  engine['account'] = { accountId: me, deviceId: device, username: 'me', displayName: 'Me', token: '' }
  engine['core'] = { identity: () => identity, members: () => [identity, sender, makeIdentity(peer, '45'.repeat(16))], sendReaction, snapshot: () => new Uint8Array([2]) } as unknown as NonNullable<Engine['core']>
  engine['state'].conversations[id] = { id, peers: [peer], lastAt: 1 }
  engine['store'] = { getJson: async (key: string) => structuredClone(values.get(key)), putJson: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }, putBytes: vi.fn(async () => {}) } as unknown as Engine['store']
  engine['flushOutbox'] = vi.fn(async () => {})
  const apply = (emoji: string, at: number, extra: Partial<ReactionUpdate> = {}, account = peer, dev = peerDevice) => {
    const r = { target, hash, author: peer, emoji, ...extra }
    const bytes = new Uint8Array([...fromHex(r.target), ...fromHex(r.hash), ...fromHex(r.author), ...new TextEncoder().encode(r.emoji)])
    return engine['apply']({ kind: 'message', conversationId: fromHex(id), sender: makeIdentity(account, dev), sentAtMs: at, reaction: bytes } as Parameters<Engine['apply']>[0], '77'.repeat(16))
  }
  const chips = async () => (await engine.messages(id))[0]?.reactions
  return { engine, values, sendReaction, apply, chips }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('worker reaction verification and projection', () => {
  it('toggles and replaces 1 own reaction, without exposing hashes or internal history', async () => {
    const { engine, sendReaction, chips } = setup()
    await engine.react(id, target, '👍')
    expect(await chips()).toEqual([{ emoji: '👍', count: 1, own: true }])
    await engine.react(id, target, '❤️')
    expect(await chips()).toEqual([{ emoji: '❤️', count: 1, own: true }])
    await engine.react(id, target, '❤️')
    expect(await chips()).toEqual([])
    const messages = await engine.messages(id)
    expect(messages).toHaveLength(1)
    expect(messages[0]).not.toHaveProperty('contentHash')
    expect(messages[0]).not.toHaveProperty('reactionEvent')
    expect(sendReaction.mock.calls).toHaveLength(3)
    expect(engine['state'].outbox).toHaveLength(3)
    expect(engine['store'].putBytes).toHaveBeenCalledWith('core', new Uint8Array([2]))
    expect(engine['state'].conversations[id].lastAt).toBe(1)
    expect(engine['state'].conversations[id].unread).toBeUndefined()
    expect(engine['receipts'].size).toBe(0)
  })

  it('rejects legacy targets, UI hints, wrong hashes, authors, and conversation substitution', async () => {
    const { engine, values, apply, chips, sendReaction } = setup()
    await apply('👍', 10, { hash: 'bb'.repeat(32) })
    await apply('👍', 11, { author: me })
    await apply('👍', 12, { target: '99'.repeat(16) })
    expect(await chips()).toEqual([])
    values.set('messages:' + id, [{ ...original, contentHash: undefined, canReact: true, reactions: [{ emoji: '👍', count: 9, own: true }] }])
    expect((await engine.messages(id))[0]).toMatchObject({ canReact: false, reactions: [] })
    await expect(engine.react(id, target, '👍')).rejects.toThrow('cannot be verified')
    await expect(engine.react('88'.repeat(16), target, '👍')).rejects.toThrow()
    expect(sendReaction).not.toHaveBeenCalled()
    expect((values.get('messages:' + id) as typeof original[])[0].contentHash).toBeUndefined()
  })

  it('converges under replace/remove reordering, duplicates, and replay after reload', async () => {
    const { engine, apply, chips, values } = setup()
    await apply('', 30)
    await apply('❤️', 20)
    await apply('👍', 10)
    await apply('❤️', 20)
    expect(await chips()).toEqual([])
    expect(values.get('messages:' + id)).toHaveLength(4)
    await apply('😮', 40)
    expect(await chips()).toEqual([{ emoji: '😮', count: 1, own: false }])
    const reloaded = setup()
    reloaded.values.set('messages:' + id, structuredClone(values.get('messages:' + id)))
    await reloaded.apply('❤️', 20)
    expect(await reloaded.chips()).toEqual(await chips())
    expect((await engine.messages(id))).toHaveLength(1)
  })

  it('orders multiple devices for 1 account independently from delivery order', async () => {
    const { apply, chips } = setup()
    await apply('❤️', 20, {}, peer, '45'.repeat(16))
    await apply('👍', 20)
    expect(await chips()).toEqual([{ emoji: '❤️', count: 1, own: false }])
    await apply('', 20, {}, peer, '45'.repeat(16))
    expect(await chips()).toEqual([])
    await apply('❤️', 20, {}, peer, '45'.repeat(16))
    expect(await chips()).toEqual([])
    const a: ReactionUpdate = { target, hash, author: peer, account: peer, device, emoji: '👍', at: 1 }
    expect(newer({ ...a, emoji: '' }, a)).toBe(true)
  })

  it('waits for a verified original when reactions arrive first, without reconstructing hashes', async () => {
    const { engine, values, apply } = setup()
    values.set('messages:' + id, [])
    await apply('👍', 10)
    expect(await engine.messages(id)).toEqual([])
    let log = values.get('messages:' + id) as unknown[]
    values.set('messages:' + id, [...log, { ...original, contentHash: undefined }])
    expect((await engine.messages(id))[0].reactions).toEqual([])
    log = (values.get('messages:' + id) as unknown[]).slice(0, 1)
    values.set('messages:' + id, [...log, original])
    expect((await engine.messages(id))[0].reactions).toEqual([{ emoji: '👍', count: 1, own: false }])
  })

  it('allows only own removal through retained verified evidence when eligibility disappears', async () => {
    const { engine, values, chips, sendReaction } = setup()
    await engine.react(id, target, '👍')
    const history = values.get('messages:' + id) as (typeof original)[]
    delete (history[0] as Partial<typeof original>).contentHash
    values.set('messages:' + id, history)
    expect((await engine.messages(id))[0].canReact).toBe(false)
    expect(await chips()).toEqual([{ emoji: '👍', count: 1, own: true }])
    await expect(engine.react(id, target, '❤️')).rejects.toThrow('cannot be verified')
    await engine.react(id, target, '👍')
    expect(await chips()).toEqual([])
    expect(sendReaction).toHaveBeenCalledTimes(2)
  })

  it('ignores former members, blocked senders, requests, and invalid emoji', async () => {
    const { engine, apply, chips } = setup()
    await apply('👍', 1, {}, '99'.repeat(16))
    await apply('not an emoji', 2)
    engine['state'].blocked = [peer]
    await apply('👍', 3)
    engine['state'].blocked = []
    engine['state'].conversations[id].request = true
    await apply('👍', 4)
    expect(await chips()).toEqual([])
  })

  it('preserves encrypted backup history and tombstones without device-sync metadata', async () => {
    const { engine, apply, values } = setup()
    await apply('👍', 10)
    await apply('', 20)
    const { encryption } = await deriveBackupKeys(new Uint8Array(16).fill(7))
    engine['store'].getKey = vi.fn(async () => encryption)
    engine['state'].backup = { lastAt: 0 }
    let bytes: Uint8Array | undefined
    vi.spyOn(api, 'uploadBackup').mockImplementation(async (_token, payload) => { bytes = payload; return undefined as never })
    await engine.backupNow()
    expect(new TextDecoder().decode(bytes)).not.toContain('reactionEvent')
    const restored = await openBackup<{ messages: Record<string, unknown[]> }>(encryption, bytes!)
    const reloaded = setup()
    reloaded.values.set('messages:' + id, restored.messages[id])
    await reloaded.apply('👍', 10)
    expect(await reloaded.chips()).toEqual([])
    expect(restored.messages[id]).toEqual(values.get('messages:' + id))
    expect(JSON.stringify(engine['state'].syncedMeta)).not.toContain('reaction')
  })
})

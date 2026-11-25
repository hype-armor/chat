/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { api, fromBase64, toBase64 } from './api'
import { Engine } from './engine'
import { fromHex, makeIdentity, randomId, toHex } from './ids'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'

beforeAll(() => initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) }))
afterEach(() => vi.restoreAllMocks())

const hex = (value: string) => value.repeat(16)
const people = {
  alice: { account: hex('11'), device: hex('aa') }, bob: { account: hex('22'), device: hex('bb') },
  cathy: { account: hex('33'), device: hex('cc') }, outsider: { account: hex('44'), device: hex('dd') },
}
const identity = ({ account, device }: typeof people.alice) => makeIdentity(account, device)
const uuid = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`

function setup() {
  const cores = Object.fromEntries(Object.entries(people).map(([name, person]) =>
    [name, new PendingClient().intoClient(identity(person))])) as Record<keyof typeof people, CoreClient>
  const group = cores.alice.startConversation([identity(people.bob), identity(people.cathy)],
    [...cores.bob.keyPackages(1), ...cores.cathy.keyPackages(1)], randomId())
  cores.bob.receive(group.welcome)
  cores.cathy.receive(group.welcome)
  const parentId = toHex(group.conversationId)
  const lookup = vi.spyOn(api, 'lookup').mockImplementation(async (_, name) => {
    const person = people[name as keyof typeof people]
    return { account_id: uuid(person.account), device_ids: [uuid(person.device)] }
  })
  const claim = vi.spyOn(api, 'claim').mockImplementation(async (_, devices) => ({ key_packages: Object.fromEntries(devices.map((device) => {
    const who = (Object.keys(people) as (keyof typeof people)[]).find((name) => uuid(people[name].device) === device)!
    return [device, toBase64(cores[who].keyPackages(1)[0])]
  })) }))

  function worker(who: keyof typeof people, enabled = true) {
    const core = cores[who], person = people[who]
    const engine = new Engine(() => {}, { restrictedChannels: enabled })
    const values = new Map<string, unknown>()
    const send = vi.fn()
    engine['account'] = { accountId: person.account, deviceId: person.device, username: who, displayName: who, token: '' }
    engine['core'] = core
    engine['connection'] = 'online'
    engine['ws'] = { close: vi.fn(), send } as unknown as Engine['ws']
    engine['request'] = vi.fn(async () => undefined)
    engine['replenishKeyPackages'] = vi.fn(async () => undefined)
    engine['scheduleSync'] = vi.fn()
    engine['store'] = {
      getJson: vi.fn(async (key: string) => structuredClone(values.get(key))),
      putJson: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }),
      putBatch: vi.fn(async (entries: [string, Uint8Array][]) => { for (const [key, value] of entries) values.set(key, value.slice()) }),
    } as unknown as Engine['store']
    if (who !== 'outsider') engine['state'].conversations[parentId] = {
      id: parentId, name: 'Main group', admins: [people.alice.account], lastAt: 1,
      peers: [people.alice, people.bob, people.cathy].filter((peer) => peer !== person).map((peer) => peer.account),
    }
    const deliver = (conversationId: string, envelope: Uint8Array, welcome = false) =>
      engine['onDeliver']({ conversationId: fromHex(conversationId), envelope, messageId: randomId(), welcome } as Parameters<Engine['onDeliver']>[0])
    const summary = (id: string) => { const view = engine.view(); return view.phase === 'ready' ? view.conversations.find((c) => c.id === id) : undefined }
    return { core, engine, values, deliver, summary, send }
  }
  return { parentId, lookup, claim, worker }
}

describe('restricted channels with real MLS', () => {
  it('creates a separate encrypted conversation visible only to its invitee, then invites another parent member', async () => {
    const { parentId, claim, worker } = setup()
    const alice = worker('alice'), bob = worker('bob'), cathy = worker('cathy')
    const channelId = await alice.engine.createRestrictedChannel(parentId, 'Private channel', ['bob'])
    expect(claim).toHaveBeenCalledWith('', [uuid(people.bob.device)])
    const initial = alice.engine['state'].outbox.slice()
    expect(initial).toHaveLength(2)
    expect(initial.every((item) => item.conversationId === channelId && item.silent && item.recipients.join() === people.bob.device)).toBe(true)
    expect(new TextDecoder().decode(fromBase64(initial[1].envelope))).not.toContain('Private channel')
    expect(() => cathy.core.receive(fromBase64(initial[0].envelope))).toThrow()
    expect(cathy.summary(channelId)).toBeUndefined()
    await bob.deliver(channelId, fromBase64(initial[0].envelope), true)
    await bob.deliver(channelId, fromBase64(initial[1].envelope))
    expect(bob.summary(channelId)).toMatchObject({ title: 'Private channel', channelParentId: parentId, channelSendPaused: false, canInviteToRestrictedChannel: false })
    expect(alice.summary(channelId)).toMatchObject({ canInviteToRestrictedChannel: true })
    const otherCommit = { conversationId: hex('ff'), commitHash: 'unresolved' }
    alice.engine['state'].pendingCommit = otherCommit
    await expect(alice.engine.inviteToRestrictedChannel(channelId, ['cathy'])).rejects.toThrow('membership is unavailable')
    expect(alice.engine['state'].pendingCommit).toBe(otherCommit)
    alice.engine['state'].pendingCommit = undefined
    const existing = new Set(bob.engine['state'].outbox)
    await bob.engine.sendText(channelId, 'Only here')
    const item = bob.engine['state'].outbox.find((entry) => entry.conversationId === channelId && !existing.has(entry))!
    expect(item.recipients).toEqual([people.alice.device])
    const text = fromBase64(item.envelope)
    expect(alice.core.receive(text).text).toBe('Only here')
    expect(() => cathy.core.receive(text)).toThrow()

    alice.engine['state'].outbox = []
    const sendCommit = alice.engine['sendCommit'].bind(alice.engine)
    alice.engine['sendCommit'] = vi.fn(async (pending, commit, recipients, welcome, members) => {
      expect(recipients).toEqual([people.bob.device])
      expect(welcome?.recipients).toEqual([people.cathy.device])
      alice.engine['request'] = vi.fn(async () => {
        const app = JSON.parse(new TextDecoder().decode(alice.values.get('app') as Uint8Array))
        expect(app.pendingCommit?.commitHash).toBe(pending.commitHash)
        await bob.deliver(channelId, commit)
        await cathy.deliver(channelId, welcome!.envelope, true)
        alice.engine['request'] = vi.fn(async () => undefined)
        return { kind: 'send_result', accepted: true } as Awaited<ReturnType<Engine['request']>>
      })
      return sendCommit(pending, commit, recipients, welcome, members)
    })
    await alice.engine.inviteToRestrictedChannel(channelId, ['cathy'])
    expect(cathy.summary(channelId)?.channelParentId).toBeUndefined()
    const info = alice.engine['state'].outbox.find((item) => item.conversationId === channelId)!
    await cathy.deliver(channelId, fromBase64(info.envelope))
    expect(cathy.summary(channelId)).toMatchObject({ title: 'Private channel', channelParentId: parentId })
    expect(() => cathy.core.receive(text)).toThrow()
  })

  it('persists an authenticated notice while the parent is unstable and checks it after a commit', async () => {
    const { parentId, worker } = setup()
    const alice = worker('alice'), bob = worker('bob'), cathy = worker('cathy')
    const channelId = await alice.engine.createRestrictedChannel(parentId, 'Private channel', ['bob'])
    const [welcome, info] = alice.engine['state'].outbox
    const proposal = cathy.core.leave(fromHex(parentId), randomId())
    alice.core.receive(proposal)
    await bob.deliver(parentId, proposal)
    await bob.deliver(channelId, fromBase64(welcome.envelope), true)
    await bob.deliver(channelId, fromBase64(info.envelope))
    const app = JSON.parse(new TextDecoder().decode(bob.values.get('app') as Uint8Array))
    expect(app.conversations[channelId].channelInfoCandidate).toMatchObject({ parentId, name: 'Private channel' })
    const candidate = bob.engine['state'].conversations[channelId]
    expect(bob.engine['directorySyncEligible'](candidate)).toBe(false)
    expect(bob.engine['syncRosterMatches'](channelId, { conversation: candidate, members: [] })).toBe(false)
    expect(bob.summary(channelId)).toBeUndefined()
    const commit = alice.core.commitProposals(fromHex(parentId), randomId())
    alice.core.confirmCommit(fromHex(parentId))
    await bob.deliver(parentId, commit.commit)
    expect(bob.summary(channelId)).toMatchObject({ channelParentId: parentId, title: 'Private channel' })
  })

  it('does not disclose a local channel or send its welcome when create persistence fails', async () => {
    const { parentId, worker } = setup()
    const alice = worker('alice')
    vi.mocked(alice.engine['store'].putBatch).mockRejectedValueOnce(new Error('write failed'))
    await expect(alice.engine.createRestrictedChannel(parentId, 'Private channel', ['bob'])).rejects.toThrow('write failed')
    const welcome = alice.engine['state'].outbox[0]
    expect(alice.summary(welcome.conversationId)).toBeUndefined()
    await alice.engine['flushOutbox']()
    expect(alice.engine['request']).not.toHaveBeenCalled()
  })

  it('does not publish or acknowledge a received binding if the storage batch fails', async () => {
    const { parentId, worker } = setup()
    const alice = worker('alice'), bob = worker('bob')
    const channelId = await alice.engine.createRestrictedChannel(parentId, 'Private channel', ['bob'])
    const [welcome, info] = alice.engine['state'].outbox
    await bob.deliver(channelId, fromBase64(welcome.envelope), true)
    expect(bob.send).toHaveBeenCalledOnce()
    vi.mocked(bob.engine['store'].putBatch).mockRejectedValueOnce(new Error('write failed'))
    await expect(bob.deliver(channelId, fromBase64(info.envelope))).rejects.toThrow('write failed')
    expect(bob.send).toHaveBeenCalledOnce()
    expect(bob.summary(channelId)).toBeUndefined()
  })

  it('rejects outsiders before claiming keys and pauses sends if a parent member is removed', async () => {
    const { parentId, claim, worker } = setup()
    const alice = worker('alice'), bob = worker('bob'), cathy = worker('cathy')
    await expect(bob.engine.createRestrictedChannel(parentId, 'Not allowed', ['cathy'])).rejects.toThrow('cannot create')
    await expect(alice.engine.createRestrictedChannel(parentId, 'Private channel', ['outsider'])).rejects.toThrow('Only current parent group members')
    expect(claim).not.toHaveBeenCalled()
    const channelId = await alice.engine.createRestrictedChannel(parentId, 'Private channel', ['bob'])
    const [welcome, info] = alice.engine['state'].outbox
    await bob.deliver(channelId, fromBase64(welcome.envelope), true)
    await bob.deliver(channelId, fromBase64(info.envelope))
    const remove = cathy.core.removeMembers(fromHex(parentId), [fromHex(people.bob.account)], randomId())
    cathy.core.confirmCommit(fromHex(parentId))
    await alice.deliver(parentId, remove.commit)
    expect(alice.summary(channelId)?.channelSendPaused).toBe(true)
    await expect(alice.engine.sendText(channelId, 'Must not send')).rejects.toThrow('paused')
    await expect(alice.engine.inviteToRestrictedChannel(channelId, ['cathy'])).rejects.toThrow('membership is unavailable')
  })
})

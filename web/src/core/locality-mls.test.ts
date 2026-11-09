/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'
import { Engine } from './engine'
import { api, fromBase64 } from './api'
import { makeIdentity, randomId, toHex } from './ids'
import { LOCALITY_TTL_MS } from './locality'
import { openBackup } from './backup'
import * as lookup from './localityLookup'

const aliceId = '11'.repeat(16)
const bobId = '33'.repeat(16)
const place = { city: 'Austin', region: 'TX', countryCode: 'US', approximate: true as const, label: 'Near Austin, TX' }
const fix = { latitude: 30.2672, longitude: -97.7431, accuracyM: 12 }
const engines: Engine[] = []

beforeAll(() => { initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) }) })
afterEach(() => {
  for (const engine of engines.splice(0)) clearTimeout(engine['localityTimer'])
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup() {
  const alice = new PendingClient().intoClient(makeIdentity(aliceId, '22'.repeat(16)))
  const bob = new PendingClient().intoClient(makeIdentity(bobId, '44'.repeat(16)))
  const started = alice.startConversation([makeIdentity(bobId, '44'.repeat(16))], bob.keyPackages(1), randomId())
  expect(bob.receive(started.welcome).kind).toBe('joined')
  const id = toHex(started.conversationId)
  function worker(core: CoreClient, accountId: string, peer: string) {
    const events = vi.fn()
    const engine = new Engine(events)
    engines.push(engine)
    const values = new Map<string, unknown>()
    engine['store'] = {
      getJson: async (key: string) => structuredClone(values.get(key)),
      putJson: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
      putBytes: async () => {},
      clear: async () => values.clear(),
    } as unknown as Engine['store']
    engine['account'] = { accountId, deviceId: accountId === aliceId ? '22'.repeat(16) : '44'.repeat(16), username: 'test.00', displayName: 'Test', token: 'synthetic' }
    engine['core'] = core
    engine['state'].conversations[id] = { id, peers: [peer], lastAt: 1, unread: 0 }
    engine['flushOutbox'] = vi.fn(async () => {})
    return { engine, values, events }
  }
  const sender = worker(alice, aliceId, bobId)
  const receiver = worker(bob, bobId, aliceId)
  async function deliver(index: number) {
    const queued = sender.engine['state'].outbox[index]
    await receiver.engine['apply'](bob.receive(fromBase64(queued.envelope)), queued.messageId)
    await receiver.engine['persist']()
  }
  const locality = () => {
    const view = receiver.engine.view()
    return view.phase === 'ready' ? view.conversations[0]?.locality : undefined
  }
  return { id, alice, bob, sender, receiver, deliver, locality, conversationId: started.conversationId }
}

describe('automatic locality over real MLS and worker state', () => {
  it('requires opt-in, resolves only in the worker, and stores no fix or history message', async () => {
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const { sender, receiver, deliver, locality } = setup()
    await sender.engine.updateLocality(aliceId, fix)
    expect(resolver).not.toHaveBeenCalled()
    await sender.engine.setLocalitySharing(aliceId, true)
    await sender.engine.updateLocality(aliceId, fix)
    expect(resolver).toHaveBeenCalledWith(fix.latitude, fix.longitude, fix.accuracyM)
    expect(sender.engine['state'].outbox).toHaveLength(1)
    expect(sender.engine['state'].outbox[0].silent).toBe(true)
    expect(new TextDecoder().decode(fromBase64(sender.engine['state'].outbox[0].envelope))).not.toContain('Austin')
    await deliver(0)
    expect(locality()).toMatchObject({ city: 'Austin', region: 'TX', country: 'US' })
    expect(receiver.engine['state'].conversations[Object.keys(receiver.engine['state'].conversations)[0]].unread).toBe(0)
    for (const values of [sender.values, receiver.values]) {
      const stored = JSON.stringify([...values])
      expect(stored).not.toMatch(/latitude|longitude|accuracyM|30\.2672|-97\.7431/)
      expect([...values.keys()].some((key) => key.startsWith('messages:'))).toBe(false)
    }
  })

  it('queues a revocation after earlier ciphertext and preserves the MLS ratchet', async () => {
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const { sender, deliver, locality, alice, bob, conversationId } = setup()
    await sender.engine.setLocalitySharing(aliceId, true)
    await sender.engine.updateLocality(aliceId, fix)
    await sender.engine.setLocalitySharing(aliceId, false)
    expect(sender.engine['state'].outbox).toHaveLength(2)
    await deliver(0)
    expect(locality()?.city).toBe('Austin')
    await deliver(1)
    expect(locality()).toBeUndefined()
    expect(bob.receive(alice.sendText(conversationId, 'After the revocation', Date.now(), randomId())).text).toBe('After the revocation')
  })

  it.each(['blocked', 'request', 'removed', 'group', 'self'] as const)('excludes %s conversations from publication and display', async (reason) => {
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const { id, sender, receiver, alice, bob, conversationId, locality } = setup()
    for (const engine of [sender.engine, receiver.engine]) {
      const conv = engine['state'].conversations[id]
      if (reason === 'blocked') engine['state'].blocked.push(engine === sender.engine ? bobId : aliceId)
      if (reason === 'request') conv.request = true
      if (reason === 'removed') conv.status = 'removed'
      if (reason === 'group') { conv.name = 'A group'; conv.admins = [aliceId] }
      if (reason === 'self') conv.self = true
    }
    await sender.engine.setLocalitySharing(aliceId, true)
    await sender.engine.updateLocality(aliceId, fix)
    expect(sender.engine['state'].outbox).toHaveLength(0)
    const now = Date.now()
    await receiver.engine['apply'](bob.receive(alice.sendLocality(conversationId, 'Austin', 'TX', 'US', now + LOCALITY_TTL_MS, now, randomId())), toHex(randomId()))
    expect(locality()).toBeUndefined()
    expect(receiver.engine['state'].localities).toBeUndefined()
  })

  it('rejects expired retries, older updates, and starts after an equal-time revocation', async () => {
    const { receiver, alice, bob, conversationId, locality } = setup()
    const now = Date.now()
    for (const [city, sent, expires] of [
      ['Austin', now - LOCALITY_TTL_MS, now - 1],
      ['', now, now + LOCALITY_TTL_MS],
      ['Austin', now, now + LOCALITY_TTL_MS],
      ['Austin', now - 1, now + LOCALITY_TTL_MS - 1],
    ] as const) {
      await receiver.engine['apply'](bob.receive(alice.sendLocality(conversationId, city, city ? 'TX' : '', city ? 'US' : '', expires, sent, randomId())), toHex(randomId()))
      expect(locality()).toBeUndefined()
    }
  })

  it('fences in-flight lookup results when consent or the account changes', async () => {
    let release!: (value: lookup.Locality) => void
    vi.spyOn(lookup, 'lookupLocality').mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const { sender } = setup()
    await sender.engine.setLocalitySharing(aliceId, true)
    const updating = sender.engine.updateLocality(aliceId, fix)
    await sender.engine.setLocalitySharing(aliceId, false)
    release(place)
    await updating
    expect(sender.engine['state'].localityOwn).toBeUndefined()
    expect(sender.engine['state'].outbox).toHaveLength(1)
    await expect(sender.engine.setLocalitySharing(bobId, true)).rejects.toThrow('account session changed')
    await sender.engine.setLocalitySharing(aliceId, true)
    const next = sender.engine.updateLocality(aliceId, fix)
    await sender.engine['signOut']('Synthetic test')
    release(place)
    await next
    expect(sender.engine['state'].localitySharing).toBeUndefined()
    expect(sender.engine['state'].outbox).toEqual([])
  })

  it('expires through wall-clock rollback and rate-limits unknown fixes too', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10 * LOCALITY_TTL_MS)
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const { sender, deliver, locality } = setup()
    await sender.engine.setLocalitySharing(aliceId, true)
    await sender.engine.updateLocality(aliceId, fix)
    await deliver(0)
    expect(locality()).toBeDefined()
    vi.setSystemTime(5 * LOCALITY_TTL_MS)
    await vi.advanceTimersByTimeAsync(LOCALITY_TTL_MS + 1)
    expect(locality()).toBeUndefined()
    resolver.mockResolvedValue(undefined)
    await sender.engine.updateLocality(aliceId, fix)
    await sender.engine.updateLocality(aliceId, fix)
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it.each(['off', 'unavailable'] as const)('persists %s immediately during a pending commit and sends the deferred removal after resolution', async (action) => {
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const { sender, id, alice, deliver, locality } = setup()
    await sender.engine.setLocalitySharing(aliceId, true)
    await sender.engine.updateLocality(aliceId, fix)
    await deliver(0)
    sender.engine['state'].pendingCommit = { conversationId: id, commitHash: 'pending' }
    if (action === 'off') await sender.engine.setLocalitySharing(aliceId, false)
    else await sender.engine.localityUnavailable(aliceId)
    expect(sender.engine['state'].localityOwn).toBeUndefined()
    expect(sender.engine['state'].localityRemovalPending).toBe(true)
    if (action === 'off') expect((sender.values.get('app') as { localitySharing: boolean }).localitySharing).toBe(false)
    expect(sender.engine['state'].outbox).toHaveLength(1)
    vi.spyOn(api, 'groupEpoch').mockResolvedValue({ epoch: 1, last_commit_hash: 'different' })
    vi.spyOn(alice, 'discardCommit').mockImplementation(() => {})
    await sender.engine['resolvePendingCommit']()
    expect(sender.engine['state'].localityRemovalPending).toBe(false)
    expect(sender.engine['state'].outbox).toHaveLength(2)
    await deliver(1)
    expect(locality()).toBeUndefined()
  })

  it('skips cached locality that expires during profile timestamp allocation', async () => {
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const { sender, alice, id } = setup()
    await sender.engine.setLocalitySharing(aliceId, true)
    await sender.engine.updateLocality(aliceId, fix)
    const expires = sender.engine['state'].localityOwn!.expiresAt
    sender.engine['localityTime'] = () => expires
    const send = vi.spyOn(alice, 'sendLocality')
    expect(() => sender.engine['queueProfile'](id)).not.toThrow()
    expect(send).not.toHaveBeenCalled()
    expect(sender.engine['state'].outbox).toHaveLength(2)
  })

  it('does not let an old account lookup block or clear the new account lookup', async () => {
    const releases: ((value: lookup.Locality) => void)[] = []
    const resolve = vi.spyOn(lookup, 'lookupLocality').mockImplementation(() => new Promise((done) => { releases.push(done) }))
    const { sender, receiver, id } = setup()
    await sender.engine.setLocalitySharing(aliceId, true)
    const old = sender.engine.updateLocality(aliceId, fix)
    await sender.engine['signOut']('Synthetic replacement')
    sender.engine['account'] = { ...receiver.engine['account']! }
    sender.engine['core'] = receiver.engine['core']
    sender.engine['state'].conversations[id] = { id, peers: [aliceId], lastAt: 1 }
    await sender.engine.setLocalitySharing(bobId, true)
    const next = sender.engine.updateLocality(bobId, fix)
    expect(resolve).toHaveBeenCalledTimes(2)
    releases[0](place)
    await old
    expect(sender.engine['localityLookupPending']?.account).toBe(bobId)
    await sender.engine.updateLocality(bobId, fix)
    expect(resolve).toHaveBeenCalledTimes(2)
    releases[1](place)
    await next
    expect(sender.engine['state'].localityOwn?.city).toBe('Austin')
  })

  it('excludes consent and locality from real encrypted backups and device sync', async () => {
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const { sender, alice, bob, conversationId, id } = setup()
    await sender.engine.setLocalitySharing(aliceId, true)
    await sender.engine.updateLocality(aliceId, fix)
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    sender.engine['store'].getKey = async () => key
    sender.engine['state'].backup = {}
    const upload = vi.spyOn(api, 'uploadBackup').mockResolvedValue(new Uint8Array())
    await sender.engine.backupNow()
    const payload = await openBackup(key, upload.mock.calls[0][1])
    expect(JSON.stringify(payload)).not.toMatch(/localit|Austin|latitude|longitude/i)
    const sendSync = vi.spyOn(alice, 'sendDeviceSync')
    sender.engine['queueDeviceSync'](id)
    const sync = JSON.parse(new TextDecoder().decode(sendSync.mock.calls[0][1]))
    expect(JSON.stringify(sync)).not.toMatch(/localit|Austin|latitude|longitude/i)
    // The additional sync remains valid MLS content, not a separate plaintext channel.
    const last = sender.engine['state'].outbox.at(-1)!
    // Consume the prior locality update first to retain ordinary message order.
    bob.receive(fromBase64(sender.engine['state'].outbox[0].envelope)).free()
    expect(bob.receive(fromBase64(last.envelope)).deviceSync).toBeDefined()
    expect(conversationId).toBeDefined()
  })
})

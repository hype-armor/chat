/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'
import { Engine } from './engine'
import { api, fromBase64, toBase64 } from './api'
import { makeIdentity, randomId, toHex } from './ids'
import { LOCALITY_TTL_MS } from './locality'
import { openBackup } from './backup'
import * as lookup from './localityLookup'
import * as maps from './maps'

const NOW = 1_700_000_000_000
const aliceId = '11'.repeat(16)
const aliceDevice = '22'.repeat(16)
const bobId = '33'.repeat(16)
const place = { city: 'Austin', region: 'TX', countryCode: 'US', approximate: true as const, label: 'Near Austin, TX' }
const fix = { latitude: 30.2672, longitude: -97.7431, accuracyM: 12 }
const engines: Engine[] = []

beforeAll(() => { initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) }) })
afterEach(() => {
  for (const engine of engines.splice(0)) {
    clearTimeout(engine['localityTimer'])
    clearInterval(engine['liveTimer'])
    clearTimeout(engine['receiptTimer'])
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup(withSecondSenderDevice = false) {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.spyOn(maps, 'prepareArea').mockImplementation(() => {})
  const alice = new PendingClient().intoClient(makeIdentity(aliceId, aliceDevice))
  const bob = new PendingClient().intoClient(makeIdentity(bobId, '44'.repeat(16)))
  const sibling = withSecondSenderDevice ? new PendingClient().intoClient(makeIdentity(aliceId, '77'.repeat(16))) : undefined
  const identities = [makeIdentity(bobId, '44'.repeat(16))]
  const packages = bob.keyPackages(1)
  if (sibling) {
    identities.push(makeIdentity(aliceId, '77'.repeat(16)))
    packages.push(...sibling.keyPackages(1))
  }
  const started = alice.startConversation(identities, packages, randomId())
  expect(bob.receive(started.welcome).kind).toBe('joined')
  if (sibling) expect(sibling.receive(started.welcome).kind).toBe('joined')
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
    engine['account'] = { accountId, deviceId: accountId === aliceId ? aliceDevice : '44'.repeat(16), username: 'test.00', displayName: 'Test', token: 'synthetic' }
    engine['core'] = core
    engine['state'].conversations[id] = { id, peers: [peer], lastAt: 1, unread: 0 }
    engine['flushOutbox'] = vi.fn(async () => {})
    return { engine, values, events }
  }
  const sender = worker(alice, aliceId, bobId)
  const receiver = worker(bob, bobId, aliceId)
  async function receive(envelope: Uint8Array) {
    await receiver.engine['apply'](bob.receive(envelope), toHex(randomId()))
    await receiver.engine['persist']()
  }
  async function deliver(index: number) {
    await receive(fromBase64(sender.engine['state'].outbox[index].envelope))
  }
  const locality = () => {
    const view = receiver.engine.view()
    return view.phase === 'ready' ? view.conversations[0]?.locality : undefined
  }
  const staticShare = (at = NOW, point = fix, label = '') => receive(alice.sendLocation(started.conversationId, point.latitude, point.longitude, point.accuracyM, label, at, randomId()))
  const liveShare = (session = randomId(), at = NOW, expires = at + 8 * LOCALITY_TTL_MS, stopped = false) =>
    receive(alice.sendLiveLocation(started.conversationId, session, expires, true, !stopped, fix.latitude, fix.longitude, fix.accuracyM, at, randomId()))
  return { id, alice, bob, sibling, sender, receiver, receive, deliver, locality, staticShare, liveShare, conversationId: started.conversationId }
}

describe('locality derived from explicit shares over real MLS', () => {
  it('derives only on the recipient, adds no publication, and preserves the explicitly shared history', async () => {
    const { sender, receiver, deliver, locality, id } = setup()
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await sender.engine.sendLocation(id, fix)
    expect(resolver).not.toHaveBeenCalled()
    expect(sender.engine['state'].outbox).toHaveLength(1)
    await deliver(0)
    expect(resolver).toHaveBeenCalledWith(fix.latitude, fix.longitude, fix.accuracyM)
    expect(locality()).toEqual({ city: 'Austin', region: 'TX', country: 'US', updatedAt: NOW, expiresAt: NOW + LOCALITY_TTL_MS })
    expect(receiver.engine['state'].outbox).toHaveLength(0)
    expect((await receiver.engine.messages(id))[0].location).toEqual(fix)
    expect(JSON.stringify(receiver.values.get('app'))).not.toMatch(/Austin|latitude|longitude/)
    expect(sender.engine.view()).not.toHaveProperty('localitySharing')
    expect(sender.engine).not.toHaveProperty('setLocalitySharing')
    expect(sender.engine).not.toHaveProperty('updateLocality')
    expect(sender.engine).not.toHaveProperty('localityUnavailable')
    // Only the existing sender/recipient map preparation runs. The header adds none.
    expect(maps.prepareArea).toHaveBeenCalledTimes(2)
  })

  it.each(['blocked', 'request', 'removed', 'group', 'self'] as const)('does not derive from %s conversations', async (reason) => {
    const { receiver, id, staticShare, liveShare, locality } = setup()
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const conv = receiver.engine['state'].conversations[id]
    if (reason === 'blocked') receiver.engine['state'].blocked.push(aliceId)
    if (reason === 'request') conv.request = true
    if (reason === 'removed') conv.status = 'removed'
    if (reason === 'group') { conv.name = 'A group'; conv.admins = [aliceId] }
    if (reason === 'self') conv.self = true
    await staticShare()
    await liveShare()
    expect(resolver).not.toHaveBeenCalled()
    expect(locality()).toBeUndefined()
  })

  it('consumes queued legacy updates and revocations without labels, broadcasts, or ratchet gaps', async () => {
    const { sender, receiver, alice, bob, receive, conversationId, locality, id } = setup()
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const envelopes = [
      alice.sendLocality(conversationId, 'Austin', 'TX', 'US', NOW + LOCALITY_TTL_MS, NOW, randomId()),
      alice.sendLocality(conversationId, '', '', '', NOW + LOCALITY_TTL_MS + 1, NOW + 1, randomId()),
    ]
    sender.engine['state'].outbox = envelopes.map((envelope) => ({ conversationId: id, messageId: toHex(randomId()), envelope: toBase64(envelope), recipients: ['44'.repeat(16)], silent: true }))
    const queued = structuredClone(sender.engine['state'].outbox)
    Object.assign(sender.engine['state'], { localitySharing: true, localityOwn: { city: 'Austin' }, localities: { legacy: {} }, localityRemovalPending: true })
    sender.engine['migrateLocality']()
    expect(sender.engine['state'].outbox).toEqual(queued)
    for (const envelope of envelopes) await receive(envelope)
    expect(locality()).toBeUndefined()
    expect(resolver).not.toHaveBeenCalled()
    expect(receiver.engine['state'].outbox).toHaveLength(0)
    expect(bob.receive(alice.sendText(conversationId, 'After ignored locality', NOW, randomId())).text).toBe('After ignored locality')
  })

  it('caps delayed static shares at the original timestamp and never derives from history reads', async () => {
    const { receiver, id, staticShare, locality } = setup()
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await staticShare(NOW - LOCALITY_TTL_MS + 1000, fix, 'Untrusted city name')
    expect(locality()?.expiresAt).toBe(NOW + 1000)
    await vi.advanceTimersByTimeAsync(1001)
    expect(locality()).toBeUndefined()
    await receiver.engine.messages(id)
    await receiver.engine.messages(id)
    expect(resolver).toHaveBeenCalledOnce()
    expect(locality()).toBeUndefined()
    await staticShare(NOW - LOCALITY_TTL_MS)
    expect(locality()).toBeUndefined()
    expect(resolver).toHaveBeenCalledOnce()
  })

  it('accepts an unseen explicit share queued while offline without restarting its original lifetime', async () => {
    const { receiver, staticShare, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const sentAt = NOW - 5 * 60_000
    receiver.engine['migrateLocality']()
    await staticShare(sentAt)
    expect(locality()).toEqual({ city: 'Austin', region: 'TX', country: 'US', updatedAt: sentAt, expiresAt: sentAt + LOCALITY_TTL_MS })
  })

  it('retains processed-source ordering and stop tombstones when clearing startup caches', async () => {
    const { receiver, id, staticShare, liveShare, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const session = randomId()
    await liveShare(session, NOW - 1000)
    await liveShare(session, NOW - 999, NOW + 8 * LOCALITY_TTL_MS - 999, true)
    await staticShare(NOW)
    const fences = structuredClone(receiver.engine['state'].localityOrder?.[id])
    receiver.engine['migrateLocality']()
    expect(receiver.engine['state'].localityOrder?.[id]).toEqual(fences)
    expect(locality()).toBeUndefined()
    await staticShare(NOW - 1)
    await liveShare(session, NOW + 1)
    expect(locality()).toBeUndefined()
    await staticShare(NOW + 2)
    expect(locality()?.updatedAt).toBe(NOW + 2)
  })

  it('expires through clock rollback and rejects older authenticated packets', async () => {
    const { staticShare, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await staticShare()
    vi.setSystemTime(NOW - LOCALITY_TTL_MS)
    await vi.advanceTimersByTimeAsync(LOCALITY_TTL_MS + 1)
    expect(locality()).toBeUndefined()
    await staticShare(NOW - 1)
    expect(locality()).toBeUndefined()
  })

  it('expires a live header at the session deadline without restoring an older static label', async () => {
    const { staticShare, liveShare, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await staticShare(NOW - 1000)
    await liveShare(randomId(), NOW, NOW + 1000)
    expect(locality()?.expiresAt).toBe(NOW + 1000)
    await vi.advanceTimersByTimeAsync(1001)
    expect(locality()).toBeUndefined()
  })

  it('does not give an until-stopped point its 8-hour lease as a header lifetime', async () => {
    const { liveShare, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await liveShare()
    expect(locality()?.expiresAt).toBe(NOW + LOCALITY_TTL_MS)
  })

  it('keeps a stop tombstone and never restores an older static or stopped-session label', async () => {
    const { receiver, id, staticShare, liveShare, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const session = randomId()
    await staticShare(NOW - 1000)
    await liveShare(session)
    await liveShare(session, NOW + 1, NOW + 8 * LOCALITY_TTL_MS + 1, true)
    expect(locality()).toBeUndefined()
    await staticShare(NOW - 500)
    await liveShare(session, NOW + 2)
    expect(locality()).toBeUndefined()
    expect(receiver.engine['state'].localityOrder?.[id].closed[aliceId + ':live:' + toHex(session)]).toBe(NOW + 1)
  })

  it.each(['static', 'live'] as const)('an old-session stop does not clear a newer unrelated %s share', async (kind) => {
    const { staticShare, liveShare, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const oldSession = randomId()
    await liveShare(oldSession, NOW - 1000)
    if (kind === 'static') await staticShare()
    else await liveShare(randomId())
    await liveShare(oldSession, NOW + 1, NOW + 8 * LOCALITY_TTL_MS + 1, true)
    expect(locality()?.city).toBe('Austin')
    expect(locality()?.updatedAt).toBe(NOW)
  })

  it('keeps live consent across a real MLS device-addition epoch and accepts the next point', async () => {
    const { receiver, alice, receive, liveShare, locality, conversationId, id } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const session = randomId()
    await liveShare(session)
    const identity = makeIdentity(aliceId, '88'.repeat(16))
    const sibling = new PendingClient().intoClient(identity)
    const added = alice.addMembers(conversationId, [identity], sibling.keyPackages(1), randomId(), randomId())
    alice.confirmCommit(conversationId)
    expect(sibling.receive(added.welcome).kind).toBe('joined')
    await receive(added.commit)
    await liveShare(session, NOW + 1)
    expect(locality()?.updatedAt).toBe(NOW + 1)
    expect(receiver.engine['state'].localityOrder?.[id].closed[aliceId + ':live:' + toHex(session)]).toBeUndefined()
  })

  it('authenticates a second peer device stop through MLS and the real delivery lock', async () => {
    const { receiver, alice, bob, sibling, conversationId, id, locality } = setup(true)
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const session = randomId()
    const deliverEnvelope = async (envelope: Uint8Array) => {
      await receiver.engine['onDeliver']({ envelope, messageId: randomId(), conversationId } as Parameters<Engine['onDeliver']>[0])
      await receiver.engine['lock']
    }
    await deliverEnvelope(alice.sendLiveLocation(conversationId, session, NOW + 8 * LOCALITY_TTL_MS, true, true, fix.latitude, fix.longitude, fix.accuracyM, NOW, randomId()))
    expect(locality()?.city).toBe('Austin')
    expect(receiver.engine['headerLocalities'].get(id)?.device).toBe(aliceDevice)
    await deliverEnvelope(sibling!.sendLiveLocation(conversationId, session, NOW + 8 * LOCALITY_TTL_MS + 1, true, false, 0, 0, 0, NOW + 1, randomId()))
    expect((await receiver.engine.messages(id))[0].live?.stopped).toBe(true)
    expect(locality()).toBeUndefined()
    expect(receiver.engine['state'].localityOrder?.[id].closed[aliceId + ':live:' + toHex(session)]).toBe(NOW + 1)
    expect(bob.receive(alice.sendText(conversationId, 'After the sibling stop', NOW + 1, randomId())).text).toBe('After the sibling stop')
  })

  it('a stop received before its start prevents the delayed session from supplying a header', async () => {
    const { liveShare, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const session = randomId()
    await liveShare(session, NOW, NOW + 8 * LOCALITY_TTL_MS, true)
    await liveShare(session, NOW + 1)
    expect(locality()).toBeUndefined()
  })

  it('does not let an ambiguous newer lookup fall back to an old label or an untrusted place string', async () => {
    const { staticShare, locality } = setup()
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValueOnce(place).mockResolvedValue(undefined)
    await staticShare(NOW - 1000)
    await staticShare(NOW, fix, 'Austin, Texas')
    expect(locality()).toBeUndefined()
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('clears on block and does not reconstruct on unblock or request acceptance', async () => {
    const { receiver, id, staticShare, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await staticShare(NOW - 1)
    await receiver.engine.block(aliceId)
    await receiver.engine.unblock(aliceId)
    expect(locality()).toBeUndefined()
    await staticShare(NOW - 1)
    expect(locality()).toBeUndefined()
    receiver.engine['state'].conversations[id].request = true
    await receiver.engine.acceptRequest(id)
    await receiver.engine.messages(id)
    expect(locality()).toBeUndefined()
    await staticShare(NOW + 1)
    expect(locality()?.city).toBe('Austin')
  })

  it('does not persist derived places in app state, encrypted backups, or device sync', async () => {
    const { receiver, bob, id, staticShare } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await staticShare()
    expect(JSON.stringify(receiver.values.get('app'))).not.toMatch(/Austin|latitude|longitude/)
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    receiver.engine['store'].getKey = async () => key
    receiver.engine['state'].backup = {}
    const upload = vi.spyOn(api, 'uploadBackup').mockResolvedValue(new Uint8Array())
    await receiver.engine.backupNow()
    const payload = await openBackup<{ state: unknown; messages: unknown }>(key, upload.mock.calls[0][1])
    expect(JSON.stringify(payload.state)).not.toMatch(/localit|Austin/i)
    // Explicit source message history keeps its existing backup policy.
    expect(JSON.stringify(payload.messages)).toContain('latitude')
    const sendSync = vi.spyOn(bob, 'sendDeviceSync')
    receiver.engine['queueDeviceSync'](id)
    const sync = JSON.parse(new TextDecoder().decode(sendSync.mock.calls[0][1]))
    expect(JSON.stringify(sync)).not.toMatch(/localit|Austin|latitude|longitude/i)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { api } from './api'
import { fromHex, makeIdentity } from './ids'
import { LOCALITY_TTL_MS } from './locality'
import * as lookup from './localityLookup'
import * as maps from './maps'
import * as backup from './backup'

const NOW = 1_700_000_000_000
const account = '11'.repeat(16)
const device = '22'.repeat(16)
const peer = '33'.repeat(16)
const peerDevice = '44'.repeat(16)
const conversationId = '55'.repeat(16)
const sessionId = '66'.repeat(16)
const me = makeIdentity(account, device)
const sender = makeIdentity(peer, peerDevice)
const point = { latitude: 30.2672, longitude: -97.7431, accuracyM: 12 }
const place: lookup.Locality = { city: 'Austin', region: 'TX', countryCode: 'US', label: 'Near Austin, TX', approximate: true }

function setup() {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.spyOn(maps, 'prepareArea').mockImplementation(() => {})
  const events = vi.fn()
  const engine = new Engine(events)
  const values = new Map<string, unknown>()
  let members = [me, sender]
  engine['account'] = { accountId: account, deviceId: device, username: 'me', displayName: 'Me', token: 'synthetic-token' }
  engine['core'] = {
    identity: () => me,
    members: () => members,
    snapshot: () => new Uint8Array([3]),
    isActive: () => true,
  } as unknown as NonNullable<Engine['core']>
  engine['store'] = {
    getJson: vi.fn(async (key: string) => structuredClone(values.get(key))),
    putJson: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }),
    putBytes: vi.fn(async () => {}),
    putKey: vi.fn(async () => {}),
    clear: vi.fn(async () => { values.clear() }),
  } as unknown as Engine['store']
  engine['state'].conversations[conversationId] = { id: conversationId, peers: [peer], lastAt: 0 }
  engine['queueReceipt'] = vi.fn()
  engine['flushOutbox'] = vi.fn(async () => {})
  engine['scheduleLiveSweep'] = vi.fn()
  let sequence = 0
  function event(sentAt = NOW, live = false, stopped = false) {
    return {
      kind: 'message', conversationId: fromHex(conversationId), sender,
      sentAtMs: sentAt, contentHash: new Uint8Array(32).fill(++sequence),
      ...(live ? { live: {
        sessionId: fromHex(sessionId), expiresAtMs: sentAt + 8 * LOCALITY_TTL_MS, untilStopped: true,
        stopped, location: stopped ? undefined : { ...point, label: '', free: () => {} }, free: () => {},
      } } : { location: { ...point, label: 'Do not trust this label', free: () => {} } }),
    } as unknown as Parameters<Engine['apply']>[0]
  }
  const receive = async (message = event()) => {
    await engine['apply'](message, (++sequence).toString(16).padStart(32, '0'))
    await engine['lock']
  }
  const packets = new Map<number, Parameters<Engine['apply']>[0]>()
  engine['core']!.receive = (envelope) => packets.get(envelope[0])!
  engine['commitDepartures'] = vi.fn()
  const deliver = (message = event()) => {
    const id = ++sequence
    packets.set(id, message)
    return engine['onDeliver']({
      envelope: new Uint8Array([id]), messageId: fromHex(id.toString(16).padStart(32, '0')),
      conversationId: fromHex(conversationId),
    } as Parameters<Engine['onDeliver']>[0])
  }
  const locality = () => engine['peerLocality'](engine['state'].conversations[conversationId])
  return {
    engine, events, values, event, receive, deliver, locality,
    removeMember: () => { members = [me] },
    setMembers: (current: Uint8Array[]) => { members = current },
  }
}

function deferredLookup() {
  let release!: (value: lookup.Locality | undefined) => void
  const resolver = vi.spyOn(lookup, 'lookupLocality').mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  return { resolver, release: (value = place) => release(value) }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('explicit location source security', () => {
  it.each(['own', 'own live', 'former member', 'missing hash'] as const)('rejects %s header sources', async (reason) => {
    const { event, receive, removeMember, locality } = setup()
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const message = event(NOW, reason === 'own live')
    if (reason === 'own' || reason === 'own live') message.sender = me
    if (reason === 'former member') removeMember()
    if (reason === 'missing hash') message.contentHash = undefined
    await receive(message)
    expect(resolver).not.toHaveBeenCalled()
    expect(locality()).toBeUndefined()
  })

  it.each([NaN, Infinity, -1, 0, NOW + 2001])('rejects invalid or future source timestamp %s', async (sentAt) => {
    const { event, receive, locality } = setup()
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await receive(event(sentAt))
    expect(resolver).not.toHaveBeenCalled()
    expect(locality()).toBeUndefined()
  })

  it('fences a pending lookup when a newer authenticated source replaces it', async () => {
    const { event, receive, locality } = setup()
    const { resolver, release } = deferredLookup()
    const old = receive(event(NOW - 1))
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())
    resolver.mockResolvedValue({ ...place, city: 'New city' })
    await receive(event(NOW))
    release()
    await old
    expect(locality()?.city).toBe('New city')
  })

  it('hides the previous label while a newer source lookup remains pending', async () => {
    const { events, event, receive, locality } = setup()
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await receive(event(NOW - 1))
    expect(locality()?.city).toBe('Austin')
    let release!: () => void
    resolver.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(undefined) }))
    events.mockClear()
    const pending = receive(event(NOW))
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2))
    const views = events.mock.calls.map(([message]) => message).filter((message) => message.type === 'view')
    expect(views.at(-1).view.conversations[0].locality).toBeUndefined()
    release()
    await pending
    expect(locality()).toBeUndefined()
  })

  it('a stop invalidates a pending lookup and leaves its source tombstone', async () => {
    const { engine, event, receive, locality } = setup()
    const { resolver, release } = deferredLookup()
    const old = receive(event(NOW, true))
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())
    await receive(event(NOW + 1, true, true))
    release()
    await old
    expect(locality()).toBeUndefined()
    expect(engine['state'].localityOrder?.[conversationId].closed[peer + ':live:' + sessionId]).toBe(NOW + 1)
  })

  it.each(['block', 'removal', 'expiry', 'account'] as const)('does not publish a delayed lookup after %s', async (change) => {
    const { engine, receive, locality, removeMember } = setup()
    const { resolver, release } = deferredLookup()
    const old = receive()
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())
    if (change === 'block') { await engine.block(peer); await engine.unblock(peer) }
    if (change === 'removal') removeMember()
    if (change === 'expiry') vi.setSystemTime(NOW + LOCALITY_TTL_MS + 1)
    if (change === 'account') await engine['signOut']('Synthetic account change')
    release()
    await old
    if (change === 'account') expect(engine['headerLocalities'].size).toBe(0)
    else expect(locality()).toBeUndefined()
  })

  it.each(['stop', 'block', 'account'] as const)('the actual delivery queue finishes %s while a location lookup is stalled', async (operation) => {
    const { engine, event, deliver, locality } = setup()
    const { resolver, release } = deferredLookup()
    let delivered = false
    const first = deliver(event(NOW, true)).then(() => { delivered = true })
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())
    let finished = false
    const change = operation === 'stop' ? deliver(event(NOW + 1, true, true))
      : operation === 'block' ? engine.block(peer) : engine['signOut']('Synthetic account change')
    const changed = change.then(() => { finished = true })
    for (let turn = 0; turn < 50; turn++) await Promise.resolve()
    const deliveredBeforeLookup = delivered
    const changedBeforeLookup = finished
    release()
    await Promise.all([first, changed])
    await engine['lock']
    expect(deliveredBeforeLookup).toBe(true)
    expect(changedBeforeLookup).toBe(true)
    if (operation === 'account') expect(engine['headerLocalities'].size).toBe(0)
    else expect(locality()).toBeUndefined()
  })

  it('retains an explicit live share across a same-membership epoch and accepts its fresh update', async () => {
    const { engine, event, deliver, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    engine['observeKeysIn'] = vi.fn(async () => {})
    await deliver(event(NOW, true))
    await engine['lock']
    expect(locality()?.updatedAt).toBe(NOW)
    await deliver({ kind: 'epoch', conversationId: fromHex(conversationId) } as Parameters<Engine['apply']>[0])
    await deliver(event(NOW + 1, true))
    await engine['lock']
    expect(locality()?.updatedAt).toBe(NOW + 1)
    expect(engine['state'].localityOrder?.[conversationId].closed[peer + ':live:' + sessionId]).toBeUndefined()
  })

  it('an actual accepted stop from another current peer device clears the session header', async () => {
    const { engine, event, deliver, locality, setMembers, values } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const secondDevice = makeIdentity(peer, '77'.repeat(16))
    setMembers([me, sender, secondDevice])
    await deliver(event(NOW, true))
    await engine['lock']
    expect(locality()?.city).toBe('Austin')
    const stop = event(NOW + 1, true, true)
    stop.sender = secondDevice
    await deliver(stop)
    await engine['lock']
    const messages = values.get('messages:' + conversationId) as { live?: { stopped?: boolean } }[]
    expect(messages[0].live?.stopped).toBe(true)
    expect(locality()).toBeUndefined()
  })

  it('does not let a device removed after authentication replace a valid current-device source', async () => {
    const { engine, event, receive, locality, setMembers } = setup()
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const currentDevice = '77'.repeat(16)
    const currentIdentity = makeIdentity(peer, currentDevice)
    setMembers([me, sender, currentIdentity])
    const accepted = event(NOW - 1)
    accepted.sender = currentIdentity
    await receive(accepted)
    const order = structuredClone(engine['state'].localityOrder)
    const append = engine['appendMessage'].bind(engine)
    engine['appendMessage'] = async (...args) => {
      await append(...args)
      // The packet passed the first membership gate, but the device is now gone.
      setMembers([me, currentIdentity])
    }
    await receive(event(NOW))
    expect(locality()?.city).toBe('Austin')
    expect(engine['headerLocalities'].get(conversationId)?.device).toBe(currentDevice)
    expect(engine['state'].localityOrder).toEqual(order)
    expect(resolver).toHaveBeenCalledOnce()
  })

  it('does not let a removed device change stop tombstones or the conversation ordering fence', async () => {
    const { engine, event, receive, locality, setMembers } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const currentIdentity = makeIdentity(peer, '77'.repeat(16))
    setMembers([me, sender, currentIdentity])
    const accepted = event(NOW - 1)
    accepted.sender = currentIdentity
    await receive(accepted)
    const order = structuredClone(engine['state'].localityOrder)
    setMembers([me, currentIdentity])
    const stop = event(NOW, true, true).live!
    await engine['deriveLiveLocality'](conversationId, peer, peerDevice, NOW, stop)
    expect(locality()?.city).toBe('Austin')
    expect(engine['state'].localityOrder).toEqual(order)
  })

  it('does not copy a derived label into another direct conversation with the same peer', async () => {
    const { engine, receive, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    const otherId = '77'.repeat(16)
    engine['state'].conversations[otherId] = { id: otherId, peers: [peer], lastAt: 0 }
    await receive()
    expect(locality()?.city).toBe('Austin')
    expect(engine['peerLocality'](engine['state'].conversations[otherId])).toBeUndefined()
  })

  it('clears migration state without a broadcast or history reconstruction, and retains replay fences', async () => {
    const { engine, receive, event, locality, values } = setup()
    const resolver = vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await receive(event(NOW - 1))
    Object.assign(engine['state'], {
      localitySharing: true, localityOwn: { city: 'Legacy' }, localityStatus: 'ready', localitySentAt: NOW,
      localityRemovalPending: true, localities: { legacy: {} },
    })
    const queued = { conversationId, messageId: '88'.repeat(16), envelope: 'AQ==', recipients: [peerDevice], silent: true }
    engine['state'].outbox.push(queued)
    engine['migrateLocality']()
    await engine['persist']()
    expect(locality()).toBeUndefined()
    expect(values.get('app')).not.toHaveProperty('localitySharing')
    expect(values.get('app')).not.toHaveProperty('localityOwn')
    expect(values.get('app')).not.toHaveProperty('localities')
    expect(engine['state'].outbox).toEqual([queued])
    await engine.messages(conversationId)
    await receive(event(NOW - 1))
    expect(locality()).toBeUndefined()
    expect(resolver).toHaveBeenCalledOnce()
  })

  it('clears on member removal and does not restore a label when that member returns', async () => {
    const { engine, event, receive, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await receive(event(NOW - 1))
    await engine['endRemovedPeerLiveLocations'](conversationId, [peer], [])
    expect(locality()).toBeUndefined()
    await receive(event(NOW - 1))
    expect(locality()).toBeUndefined()
  })

  it.each(['__proto__', 'constructor', 'prototype'])('isolates the %s ordering key from built-in prototypes', (key) => {
    const { engine } = setup()
    const prototypeAt = Object.getOwnPropertyDescriptor(Object.prototype, 'at')
    const constructorAt = Object.getOwnPropertyDescriptor(Object, 'at')
    const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype)
    const constructorBefore = Object.getOwnPropertyDescriptors(Object)
    try {
      engine['state'].localityOrder = {}
      engine['forgetLocality'](key)
      const records = engine['state'].localityOrder!
      expect(Object.getPrototypeOf(records)).toBeNull()
      expect(Object.hasOwn(records, key)).toBe(true)
      expect(records[key].at).toBe(NOW)
      expect(Object.getPrototypeOf(records[key].closed)).toBeNull()
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore)
      expect(Object.getOwnPropertyDescriptors(Object)).toEqual(constructorBefore)
    } finally {
      // A failing regression must not leave the test process polluted.
      if (prototypeAt) Object.defineProperty(Object.prototype, 'at', prototypeAt)
      else Reflect.deleteProperty(Object.prototype, 'at')
      if (constructorAt) Object.defineProperty(Object, 'at', constructorAt)
      else Reflect.deleteProperty(Object, 'at')
    }
  })

  it.each(['state', 'outer', 'record'] as const)('ignores inherited %s ordering state without mutating its owner', (layer) => {
    const { engine } = setup()
    const inherited = Object.freeze({ at: NOW - 1000, closed: Object.freeze({ old: NOW - 2000 }) })
    if (layer === 'state') Object.setPrototypeOf(engine['state'], { localityOrder: { [conversationId]: inherited } })
    else engine['state'].localityOrder = layer === 'outer'
      ? Object.create({ [conversationId]: inherited })
      : { [conversationId]: Object.create(inherited) }
    const order = engine['localityOrder'](conversationId)
    expect(order.at).toBe(0)
    expect(Object.keys(order.closed)).toEqual([])
    engine['forgetLocality'](conversationId)
    expect(inherited).toEqual({ at: NOW - 1000, closed: { old: NOW - 2000 } })
    expect(engine['state'].localityOrder![conversationId].at).toBe(NOW)
  })

  it('ignores inherited closed records while retaining own persisted tombstones', () => {
    const { engine } = setup()
    const closed = Object.assign(Object.create({ constructor: NOW - 1, prototype: NOW - 2, ['__proto__']: NOW - 3 }), {
      [peer + ':live:' + sessionId]: NOW - 4,
    })
    engine['state'].localityOrder = { [conversationId]: { at: NOW - 1, closed } }
    const order = engine['localityOrder'](conversationId)
    expect(Object.getPrototypeOf(order.closed)).toBeNull()
    expect(order.closed.constructor).toBeUndefined()
    expect(order.closed.prototype).toBeUndefined()
    expect(order.closed.__proto__).toBeUndefined()
    expect(order.closed[peer + ':live:' + sessionId]).toBe(NOW - 4)
  })

  it('roundtrips ordinary persisted ordering and prototype-named tombstones without prototype changes', async () => {
    const { engine, values } = setup()
    const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype)
    const saved = JSON.parse(JSON.stringify({
      [conversationId]: { at: NOW - 10, closed: { [peer + ':live:' + sessionId]: NOW - 20 } },
      ['__proto__']: { at: NOW - 30, closed: {} },
      constructor: { at: NOW - 40, closed: {} },
      prototype: { at: NOW - 50, closed: {} },
    })) as NonNullable<Engine['state']['localityOrder']>
    // JSON.parse creates ordinary own properties, including these special keys.
    const special = JSON.parse('{"__proto__":1,"constructor":2,"prototype":3}') as Record<string, number>
    saved[conversationId].closed = { ...saved[conversationId].closed, ...special }
    engine['state'].localityOrder = saved
    const order = engine['localityOrder'](conversationId)
    expect(order.at).toBe(NOW - 10)
    expect(order.closed[peer + ':live:' + sessionId]).toBe(NOW - 20)
    expect(Object.keys(order.closed)).toEqual([peer + ':live:' + sessionId, '__proto__', 'constructor', 'prototype'])
    engine['closeLocalitySource'](order, '__proto__', NOW)
    engine['closeLocalitySource'](order, 'constructor', NOW + 1)
    engine['closeLocalitySource'](order, 'prototype', NOW + 2)
    await engine['persist']()
    const stored = values.get('app') as Engine['state']
    engine['state'].localityOrder = structuredClone(stored.localityOrder)
    const restored = engine['localityOrder'](conversationId)
    expect(restored.at).toBe(NOW - 10)
    expect(restored.closed[peer + ':live:' + sessionId]).toBe(NOW - 20)
    expect(restored.closed.__proto__).toBe(NOW)
    expect(restored.closed.constructor).toBe(NOW + 1)
    expect(restored.closed.prototype).toBe(NOW + 2)
    expect(Object.getPrototypeOf(engine['state'].localityOrder)).toBeNull()
    expect(Object.getPrototypeOf(restored.closed)).toBeNull()
    expect(engine['localityOrder']('__proto__').at).toBe(NOW - 30)
    expect(engine['localityOrder']('constructor').at).toBe(NOW - 40)
    expect(engine['localityOrder']('prototype').at).toBe(NOW - 50)
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore)
  })

  it('resets obsolete and extra locality fields in the real restore preparation path', async () => {
    const { engine, receive, locality } = setup()
    vi.spyOn(lookup, 'lookupLocality').mockResolvedValue(place)
    await receive()
    const oldState = structuredClone(engine['state'])
    Object.assign(oldState, { localitySharing: true, localityOwn: { city: 'Legacy' }, localities: { legacy: {} } })
    const accountRecord = engine['account']!
    engine['account'] = undefined
    engine['pending'] = { publicKey: () => new Uint8Array(32) } as unknown as Engine['pending']
    engine['register'] = vi.fn(async (_registration, _name, prepare) => {
      engine['account'] = accountRecord
      await prepare?.()
    })
    vi.spyOn(api, 'restore').mockResolvedValue({ account_id: account, device_id: device, token: 'synthetic', username: 'me' })
    vi.spyOn(api, 'downloadBackup').mockResolvedValue(new Uint8Array())
    vi.spyOn(backup, 'deriveBackupKeys').mockResolvedValue({ auth: new Uint8Array(32), encryption: {} as CryptoKey })
    vi.spyOn(backup, 'openBackup').mockResolvedValue({ state: oldState, messages: {}, createdAt: NOW, displayName: 'Me' })
    await engine.restore('me', backup.formatRecoveryKey(new Uint8Array(16)))
    expect(locality()).toBeUndefined()
    expect(engine['state']).not.toHaveProperty('localitySharing')
    expect(engine['state']).not.toHaveProperty('localityOwn')
    expect(engine['state']).not.toHaveProperty('localities')
    expect(engine['state'].localityOrder).toEqual({})
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { api } from './api'
import { fromHex, makeIdentity, toHex } from './ids'

const me = '11'.repeat(16), myDevice = '22'.repeat(16)
const bob = '33'.repeat(16), bobDevice = '44'.repeat(16)
const mallory = '55'.repeat(16), malloryDevice = '66'.repeat(16)
const room = '77'.repeat(16), newRoom = '88'.repeat(16), newDevice = '99'.repeat(16)
const self = makeIdentity(me, myDevice), peer = makeIdentity(bob, bobDevice)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function setup() {
  const engine = new Engine(() => {})
  const rosters = new Map<string, Uint8Array[]>()
  const members = vi.fn((id: Uint8Array) => rosters.get(toHex(id)) ?? [])
  const removeMembers = vi.fn((id: Uint8Array, identities: Uint8Array[]) => {
    const gone = identities.map(toHex)
    rosters.set(toHex(id), members(id).filter((identity) => !gone.includes(toHex(identity))))
    return { commit: new Uint8Array([1]), commitHash: new Uint8Array([2]) }
  })
  const addMembers = vi.fn((id: Uint8Array, identities: Uint8Array[]) => {
    rosters.set(toHex(id), [...members(id), ...identities])
    return { commit: new Uint8Array([1]), commitHash: new Uint8Array([2]), welcome: new Uint8Array([3]) }
  })
  engine['account'] = { accountId: me, deviceId: myDevice, username: 'me', displayName: 'Me', token: 'synthetic-token' }
  engine['core'] = { identity: () => self, members, removeMembers, addMembers, snapshot: () => new Uint8Array([4]) } as unknown as NonNullable<Engine['core']>
  engine['connection'] = 'online'
  engine['store'] = { getJson: async () => undefined, putJson: async () => {}, putBytes: async () => {}, clear: async () => {} } as unknown as Engine['store']
  engine['flushOutbox'] = vi.fn(async () => {})
  engine['sendCommit'] = vi.fn<Engine['sendCommit']>(async () => 'accepted')
  engine['scheduleSync'] = vi.fn()
  engine['createSelfConversation'] = vi.fn(async () => {})
  const addRoom = (id: string, identities: Uint8Array[]) => {
    rosters.set(id, identities)
    engine['state'].conversations[id] = { id, peers: [...new Set(identities.map((identity) => toHex(identity.slice(0, 16))))].filter((account) => account !== me), lastAt: 1 }
  }
  addRoom(room, [self, peer])
  vi.spyOn(api, 'devices').mockResolvedValue({ devices: [{ device_id: myDevice, current: true, added_on: '', last_seen_on: null }] })
  const directory = vi.spyOn(api, 'devicesOf').mockResolvedValue({ devices: { [bob]: [bobDevice] } })
  return { engine, rosters, members, removeMembers, addMembers, addRoom, directory }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('directory reconciliation snapshots', () => {
  it.each(['conversation', 'member'] as const)('does not remove an unqueried new %s after a delayed directory response', async (change) => {
    const { engine, rosters, addRoom, directory, removeMembers } = setup()
    const started = deferred<void>(), response = deferred<Awaited<ReturnType<typeof api.devicesOf>>>()
    directory.mockImplementationOnce(async () => { started.resolve(); return response.promise })
    const syncing = engine['runSync']()
    await started.promise
    expect(directory.mock.calls[0][1]).toEqual([bob])
    if (change === 'conversation') addRoom(newRoom, [self, makeIdentity(mallory, malloryDevice)])
    else rosters.set(room, [self, peer, makeIdentity(mallory, malloryDevice)])
    response.resolve({ devices: { [bob]: [bobDevice] } })
    await syncing
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['sendCommit']).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).toHaveBeenCalled()
  })

  it('does not remove a new device of a queried account on an older absent-account response', async () => {
    const { engine, rosters, directory, removeMembers } = setup()
    const started = deferred<void>(), response = deferred<Awaited<ReturnType<typeof api.devicesOf>>>()
    directory.mockImplementationOnce(async () => { started.resolve(); return response.promise })
    const syncing = engine['runSync']()
    await started.promise
    rosters.set(room, [self, peer, makeIdentity(bob, newDevice)])
    response.resolve({ devices: {} })
    await syncing
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).toHaveBeenCalled()
  })

  it('does not remove an own device joined after the own-account directory query', async () => {
    const { engine, rosters, directory, removeMembers } = setup()
    const started = deferred<void>(), response = deferred<Awaited<ReturnType<typeof api.devicesOf>>>()
    directory.mockImplementationOnce(async () => { started.resolve(); return response.promise })
    const syncing = engine['runSync']()
    await started.promise
    rosters.set(room, [self, makeIdentity(me, newDevice), peer])
    response.resolve({ devices: { [bob]: [bobDevice] } })
    await syncing
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).toHaveBeenCalled()
  })

  it('captures the roster before the first own-device directory await', async () => {
    const { engine, rosters, removeMembers } = setup()
    const started = deferred<void>(), response = deferred<Awaited<ReturnType<typeof api.devices>>>()
    vi.mocked(api.devices).mockImplementationOnce(async () => { started.resolve(); return response.promise })
    const syncing = engine['runSync']()
    await started.promise
    rosters.set(room, [self, makeIdentity(me, newDevice), peer])
    response.resolve({ devices: [{ device_id: myDevice, current: true, added_on: '', last_seen_on: null }] })
    await syncing
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).toHaveBeenCalled()
  })

  it('aborts an add when the roster changes during the key-package claim', async () => {
    const { engine, rosters, directory, addMembers, removeMembers } = setup()
    directory.mockResolvedValue({ devices: { [bob]: [newDevice] } })
    const started = deferred<void>(), response = deferred<Awaited<ReturnType<Engine['deviceInvitee']>>>()
    engine['deviceInvitee'] = vi.fn(async () => { started.resolve(); return response.promise })
    const syncing = engine['runSync']()
    await started.promise
    rosters.set(room, [self, peer, makeIdentity(mallory, malloryDevice)])
    response.resolve({ account: bob, username: 'bob', devices: [newDevice], identities: [makeIdentity(bob, newDevice)], keyPackages: [new Uint8Array([1])] })
    await syncing
    expect(addMembers).not.toHaveBeenCalled()
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).toHaveBeenCalled()
  })

  it('rechecks removal plans after a delayed outbox flush', async () => {
    const { engine, rosters, directory, removeMembers } = setup()
    directory.mockResolvedValue({ devices: {} })
    const started = deferred<void>(), gate = deferred<void>()
    engine['flushOutbox'] = vi.fn(async () => { started.resolve(); await gate.promise })
    const syncing = engine['runSync']()
    await started.promise
    rosters.set(room, [self, peer, makeIdentity(mallory, malloryDevice)])
    gate.resolve()
    await syncing
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).toHaveBeenCalled()
  })

  it('rechecks addition plans after a delayed outbox flush', async () => {
    const { engine, rosters, directory, addMembers, removeMembers } = setup()
    directory.mockResolvedValue({ devices: { [bob]: [newDevice] } })
    engine['deviceInvitee'] = vi.fn(async () => ({ account: bob, username: 'bob', devices: [newDevice], identities: [makeIdentity(bob, newDevice)], keyPackages: [new Uint8Array([1])] }))
    const started = deferred<void>(), gate = deferred<void>()
    engine['flushOutbox'] = vi.fn(async () => { started.resolve(); await gate.promise })
    const syncing = engine['runSync']()
    await started.promise
    rosters.set(room, [self, peer, makeIdentity(mallory, malloryDevice)])
    gate.resolve()
    await syncing
    expect(addMembers).not.toHaveBeenCalled()
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).toHaveBeenCalled()
  })

  it('retains additions before removals across accepted local reconciliation rounds', async () => {
    const { engine, rosters, addMembers, removeMembers } = setup()
    const stale = makeIdentity(me, 'aa'.repeat(16)), fresh = makeIdentity(me, newDevice)
    rosters.set(room, [self, stale, peer])
    vi.mocked(api.devices).mockResolvedValue({ devices: [myDevice, newDevice].map((device_id) => ({ device_id, current: device_id === myDevice, added_on: '', last_seen_on: null })) })
    engine['deviceInvitee'] = vi.fn(async () => ({ account: me, username: 'me', devices: [newDevice], identities: [fresh], keyPackages: [new Uint8Array([1])] }))
    await engine['runSync']()
    expect(addMembers).toHaveBeenCalledOnce()
    expect(removeMembers).toHaveBeenCalledOnce()
    expect(addMembers.mock.invocationCallOrder[0]).toBeLessThan(removeMembers.mock.invocationCallOrder[0])
    expect(removeMembers.mock.calls[0][1]).toEqual([stale])
    expect(rosters.get(room)).toEqual([self, peer, fresh])
    expect(engine['sendCommit']).toHaveBeenCalledTimes(2)
    expect(engine['scheduleSync']).not.toHaveBeenCalled()
  })

  it('preserves the reconciliation authority of another live account device', async () => {
    const { engine, directory, addMembers, removeMembers } = setup()
    directory.mockResolvedValue({ devices: { [bob]: [bobDevice, newDevice] } })
    await engine['runSync']()
    expect(addMembers).not.toHaveBeenCalled()
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['sendCommit']).not.toHaveBeenCalled()
  })

  it.each(['reorder', 'replace'] as const)('invalidates snapshots on roster %s even when the identity set is unchanged', async (change) => {
    const { engine, rosters, addRoom, directory, removeMembers } = setup()
    const started = deferred<void>(), response = deferred<Awaited<ReturnType<typeof api.devicesOf>>>()
    directory.mockImplementationOnce(async () => { started.resolve(); return response.promise })
    const syncing = engine['runSync']()
    await started.promise
    if (change === 'reorder') rosters.set(room, [peer, self])
    else addRoom(room, [self, peer])
    response.resolve({ devices: {} })
    await syncing
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).toHaveBeenCalled()
  })

  it('debounces changed-roster resync and stops after the next stable snapshot', async () => {
    vi.useFakeTimers()
    const { engine, addRoom, directory, removeMembers } = setup()
    engine['scheduleSync'] = Engine.prototype['scheduleSync'].bind(engine)
    const started = deferred<void>(), response = deferred<Awaited<ReturnType<typeof api.devicesOf>>>()
    directory.mockResolvedValue({ devices: { [bob]: [bobDevice], [mallory]: [malloryDevice] } })
    directory.mockImplementationOnce(async () => { started.resolve(); return response.promise })
    const syncing = engine['runSync']()
    await started.promise
    addRoom(newRoom, [self, makeIdentity(mallory, malloryDevice)])
    response.resolve({ devices: { [bob]: [bobDevice] } })
    await syncing
    expect(api.devices).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(api.devices).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await engine['syncChain']
    expect(api.devices).toHaveBeenCalledTimes(2)
    expect(directory.mock.calls[1][1]).toEqual([bob, mallory])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.devices).toHaveBeenCalledTimes(2)
    expect(removeMembers).not.toHaveBeenCalled()
  })

  it.each(['own', 'peer'] as const)('ignores a delayed %s directory response after account/session replacement', async (stage) => {
    const { engine, directory, removeMembers } = setup()
    const originalCore = engine['core']
    const started = deferred<void>(), gate = deferred<void>()
    if (stage === 'own') vi.mocked(api.devices).mockImplementationOnce(async () => { started.resolve(); await gate.promise; return { devices: [] } })
    else directory.mockImplementationOnce(async () => { started.resolve(); await gate.promise; return { devices: {} } })
    const syncing = engine['runSync']()
    await started.promise
    await engine['signOut']('Reset')
    engine['endingSession'] = false
    engine['connection'] = 'online'
    engine['account'] = { accountId: mallory, deviceId: malloryDevice, username: 'new', displayName: 'New', token: 'new-token' }
    engine['core'] = originalCore
    engine['state'].myDevices = [malloryDevice]
    gate.resolve()
    await syncing
    expect(engine['state'].myDevices).toEqual([malloryDevice])
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).not.toHaveBeenCalled()
    if (stage === 'own') expect(directory).not.toHaveBeenCalled()
  })

  it.each(['claim', 'flush'] as const)('rejects stale session work after the %s await', async (stage) => {
    const { engine, directory, addMembers, removeMembers } = setup()
    directory.mockResolvedValue({ devices: { [bob]: [newDevice] } })
    const started = deferred<void>(), gate = deferred<void>()
    engine['deviceInvitee'] = vi.fn(async () => {
      if (stage === 'claim') { started.resolve(); await gate.promise }
      return { account: bob, username: 'bob', devices: [newDevice], identities: [makeIdentity(bob, newDevice)], keyPackages: [new Uint8Array([1])] }
    })
    if (stage === 'flush') engine['flushOutbox'] = vi.fn(async () => { started.resolve(); await gate.promise })
    const syncing = engine['runSync']()
    await started.promise
    const reset = engine['signOut']('Reset')
    gate.resolve()
    await syncing
    await reset
    expect(addMembers).not.toHaveBeenCalled()
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).not.toHaveBeenCalled()
  })

  it('fences a directory response when only the lifecycle epoch changes', async () => {
    const { engine, directory, removeMembers } = setup()
    const started = deferred<void>(), response = deferred<Awaited<ReturnType<typeof api.devicesOf>>>()
    directory.mockImplementationOnce(async () => { started.resolve(); return response.promise })
    const syncing = engine['runSync']()
    await started.promise
    engine['draftEpoch']++
    response.resolve({ devices: {} })
    await syncing
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).not.toHaveBeenCalled()
  })

  it('bounds reconciliation at 4 accepted rounds and schedules remaining work promptly', async () => {
    const { engine, addRoom, directory, addMembers, removeMembers } = setup()
    const restored = Array.from({ length: 5 }, (_, i) => ({ account: ('a' + (i + 1)).repeat(16), old: ('b' + (i + 1)).repeat(16), fresh: ('c' + (i + 1)).repeat(16) }))
    addRoom(room, [self, ...restored.map((r) => makeIdentity(r.account, r.old))])
    directory.mockResolvedValue({ devices: Object.fromEntries(restored.map((r) => [r.account, [r.fresh]])) })
    engine['deviceInvitee'] = vi.fn(async (account: string, devices: string[]) => ({ account, username: account, devices, identities: devices.map((device) => makeIdentity(account, device)), keyPackages: devices.map(() => new Uint8Array([1])) }))
    await engine['runSync']()
    expect(addMembers).toHaveBeenCalledTimes(4)
    expect(engine['scheduleSync']).toHaveBeenCalledOnce()
    await engine['runSync']()
    expect(addMembers).toHaveBeenCalledTimes(5)
    expect(engine['scheduleSync']).toHaveBeenCalledOnce()
    expect(removeMembers).not.toHaveBeenCalled()
  })

  it('does not interpret missing unqueried account coverage as deletion', async () => {
    const { engine, removeMembers } = setup()
    const expected = { conversation: engine['state'].conversations[room], members: [toHex(self), toHex(peer)] }
    await engine['reconcileDevices'](room, { [me]: [myDevice] }, new Set([me]), expected, () => true)
    expect(removeMembers).not.toHaveBeenCalled()
    expect(engine['scheduleSync']).toHaveBeenCalledOnce()
  })

  it('still removes a genuinely deleted queried account when the roster did not change', async () => {
    const { engine, directory, removeMembers } = setup()
    directory.mockResolvedValue({ devices: {} })
    await engine['runSync']()
    expect(removeMembers).toHaveBeenCalledOnce()
    expect(removeMembers.mock.calls[0][0]).toEqual(fromHex(room))
    expect(removeMembers.mock.calls[0][1]).toEqual([peer])
    expect(engine['sendCommit']).toHaveBeenCalledWith(expect.anything(), expect.anything(), [bobDevice], undefined, [myDevice])
  })
})

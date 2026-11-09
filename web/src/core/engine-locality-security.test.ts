import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, toBase64 } from './api'
import { Engine } from './engine'
import { makeIdentity, toHex } from './ids'
import { LOCALITY_TTL_MS } from './locality'

// Independent regressions for consent withdrawal, deferred removal, and cached
// expiry. MLS and storage are mocked, not the production locality methods.
const NOW = 1_700_000_000_000
const account = '11'.repeat(16)
const device = '22'.repeat(16)
const peer = '33'.repeat(16)
const peerDevice = '44'.repeat(16)
const conversationId = '55'.repeat(16)
const pendingGroupId = '66'.repeat(16)
const commitHash = toBase64(new Uint8Array(32).fill(7))
const me = makeIdentity(account, device)
const sender = makeIdentity(peer, peerDevice)
const place = { city: 'San Francisco', region: 'CA', country: 'US' }

function setup() {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const engine = new Engine(() => {})
  const values = new Map<string, unknown>()
  const sendLocality = vi.fn((
    _conversation: Uint8Array, _city: string, _region: string, _country: string,
    expiresAt: number, sentAt: number, _messageId: Uint8Array,
  ) => {
    // Match the real WASM boundary. A permissive stub would hide the expiry bug.
    if (!Number.isSafeInteger(sentAt) || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= sentAt || expiresAt - sentAt > LOCALITY_TTL_MS) {
      throw new Error('invalid locality lifetime')
    }
    return new Uint8Array([2])
  })
  const sendProfile = vi.fn((_conversation: Uint8Array, _name: string, _avatar: Uint8Array, _sentAt: number, _messageId: Uint8Array) => new Uint8Array([4]))
  const confirmCommit = vi.fn()
  const discardCommit = vi.fn()
  engine['account'] = { accountId: account, deviceId: device, username: 'me', displayName: 'Me', token: 'synthetic-token' }
  engine['core'] = {
    identity: () => me,
    members: () => [me, sender],
    snapshot: () => new Uint8Array([3]),
    hasPendingProposals: () => false,
    sendLocality, sendProfile, confirmCommit, discardCommit,
  } as unknown as NonNullable<Engine['core']>
  engine['store'] = {
    getJson: vi.fn(async (key: string) => values.get(key)),
    putJson: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }),
    putBytes: vi.fn(async () => {}),
  } as unknown as Engine['store']
  engine['state'].conversations[conversationId] = { id: conversationId, peers: [peer], lastAt: 0 }
  engine['state'].conversations[pendingGroupId] = { id: pendingGroupId, peers: [peer], name: 'Unrelated group', admins: [account], lastAt: 0 }
  engine['state'].localitySharing = true
  engine['state'].localityStatus = 'ready'
  engine['state'].localityOwn = { ...place, updatedAt: NOW - 1000, expiresAt: NOW + LOCALITY_TTL_MS - 1000 }
  engine['connection'] = 'offline'
  vi.spyOn(engine['localityClock'], 'now').mockReturnValue(NOW)
  // Key observation is unrelated to these regressions. Keep commit completion,
  // pending-state cleanup, persistence, and outbox processing real.
  engine['observeKeysIn'] = vi.fn(async () => {})
  engine['request'] = vi.fn<Engine['request']>(async () => undefined)

  const pendingCommit = () => {
    engine['state'].pendingCommit = { conversationId: pendingGroupId, commitHash }
  }
  const settle = async (accepted: boolean) => {
    vi.spyOn(api, 'groupEpoch').mockResolvedValue({ epoch: 2, last_commit_hash: accepted ? commitHash : toBase64(new Uint8Array(32).fill(8)) })
    // This is the reconnect path: resolve the durable commit before flushing.
    engine['connection'] = 'online'
    await engine['exclusive'](() => engine['resolvePendingCommit']())
    await engine['flushOutbox']()
    await engine['lock']
  }
  return { engine, values, sendLocality, sendProfile, confirmCommit, discardCommit, pendingCommit, settle }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('locality security regressions', () => {
  it('persists consent withdrawal while an unrelated commit is pending, then sends its deferred removal', async () => {
    const { engine, values, pendingCommit, settle, sendLocality } = setup()
    pendingCommit()
    await expect(engine.setLocalitySharing(account, false)).resolves.toBeUndefined()
    expect(engine['state'].localitySharing).toBe(false)
    expect(engine['state'].localityOwn).toBeUndefined()
    expect(values.get('app')).toMatchObject({ localitySharing: false, localityStatus: 'off' })
    expect(engine['state'].pendingCommit).toBeDefined()
    expect(sendLocality).not.toHaveBeenCalled()
    await settle(true)
    expect(sendLocality).toHaveBeenCalledTimes(1)
    expect(sendLocality.mock.calls[0].slice(1, 4)).toEqual(['', '', ''])
    expect(values.get('app')).toMatchObject({ localitySharing: false })
  })

  it.each([true, false])('retains permission-loss removal until the pending commit resolves (accepted=%s)', async (accepted) => {
    const { engine, values, pendingCommit, settle, sendLocality, confirmCommit, discardCommit } = setup()
    pendingCommit()
    await engine.localityUnavailable(account)
    expect(engine['state'].localityOwn).toBeUndefined()
    expect(values.get('app')).toMatchObject({ localitySharing: true, localityStatus: 'unavailable' })
    expect(sendLocality).not.toHaveBeenCalled()
    // A repeated permission failure must not erase an already deferred removal.
    await engine.localityUnavailable(account)
    await settle(accepted)
    expect(engine['state'].pendingCommit).toBeUndefined()
    expect(accepted ? confirmCommit : discardCommit).toHaveBeenCalledOnce()
    expect(sendLocality).toHaveBeenCalledTimes(1)
    const [, city, region, country, expiresAt, sentAt] = sendLocality.mock.calls[0]
    expect([city, region, country]).toEqual(['', '', ''])
    expect(expiresAt).toBeGreaterThan(sentAt)
    expect(expiresAt - sentAt).toBeLessThanOrEqual(LOCALITY_TTL_MS)
    expect(engine['state'].outbox).toHaveLength(1)
    expect(engine['state'].outbox[0]).toMatchObject({ conversationId, silent: true, recipients: [peerDevice] })
    // No additional permission change should be required to flush the removal.
    await engine['flushOutbox']()
    expect(sendLocality).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale account callback withdraw the current account consent', async () => {
    const { engine, values, pendingCommit, sendLocality } = setup()
    pendingCommit()
    await expect(engine.setLocalitySharing('99'.repeat(16), false)).rejects.toThrow('account session changed')
    expect(engine['state'].localitySharing).toBe(true)
    expect(engine['state'].localityOwn).toMatchObject(place)
    expect(values.has('app')).toBe(false)
    expect(sendLocality).not.toHaveBeenCalled()
  })

  for (const floorOffset of [-1, 0, 1]) {
    it(`continues profile introduction when the timestamp floor is expiry ${floorOffset >= 0 ? '+' : ''}${floorOffset}`, () => {
      const { engine, sendLocality, sendProfile } = setup()
      const expiry = NOW + 1
      engine['state'].localityOwn = { ...place, updatedAt: expiry - LOCALITY_TTL_MS, expiresAt: expiry }
      engine['state'].localitySentAt = expiry + floorOffset
      // The cached value passes the first wall-clock check, but localityTime()
      // reaches or exceeds its original expiry. Metadata must remain optional.
      expect(() => engine['queueProfile'](conversationId)).not.toThrow()
      expect(sendLocality).not.toHaveBeenCalled()
      expect(sendProfile).toHaveBeenCalledOnce()
      expect(toHex(sendProfile.mock.calls[0][0] as Uint8Array)).toBe(conversationId)
      expect(engine['state'].outbox).toHaveLength(1)
    })

    it(`accepts a conversation request when the timestamp floor is expiry ${floorOffset >= 0 ? '+' : ''}${floorOffset}`, async () => {
      const { engine, values, sendLocality } = setup()
      const expiry = NOW + 1
      engine['state'].conversations[conversationId].request = true
      engine['state'].localityOwn = { ...place, updatedAt: expiry - LOCALITY_TTL_MS, expiresAt: expiry }
      engine['state'].localitySentAt = expiry + floorOffset
      await expect(engine.acceptRequest(conversationId)).resolves.toBeUndefined()
      expect(engine['state'].conversations[conversationId].request).toBeUndefined()
      const saved = values.get('app') as Engine['state']
      expect(saved.conversations[conversationId].request).toBeUndefined()
      expect(sendLocality).not.toHaveBeenCalled()
      expect(engine['state'].outbox).toHaveLength(0)
    })
  }
})

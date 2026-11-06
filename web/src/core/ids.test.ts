import { describe, expect, it } from 'vitest'
import { RecentIds, fromHex, makeIdentity, splitIdentity, toHex, trySplitIdentity, uuidToBytes } from './ids'

describe('ids', () => {
  it('round-trips hex', () => {
    const bytes = new Uint8Array([0, 1, 254, 255])
    expect(toHex(bytes)).toBe('0001feff')
    expect(fromHex('0001feff')).toEqual(bytes)
    expect(() => fromHex('zz')).toThrow()
  })

  it('skips identities that are not account and device', () => {
    // A member added by a misbehaving client can carry any identity bytes.
    // Routing must skip it instead of throwing, or the whole group stops
    // sending (audit H1).
    expect(trySplitIdentity(new Uint8Array(0))).toBeUndefined()
    expect(trySplitIdentity(new Uint8Array(31))).toBeUndefined()
    expect(trySplitIdentity(new Uint8Array(33))).toBeUndefined()
    const split = trySplitIdentity(new Uint8Array(32).fill(7))
    expect(split?.account).toHaveLength(32)
    expect(split?.deviceId).toHaveLength(32)
    expect(() => splitIdentity(new Uint8Array(31))).toThrow()
  })

  it('builds and splits identities', () => {
    const account = '11111111-2222-3333-4444-555555555555'
    const device = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const identity = makeIdentity(account, device)
    expect(identity.length).toBe(32)
    const { account: a, device: d } = splitIdentity(identity)
    expect(a).toBe('11111111222233334444555555555555')
    expect(d).toEqual(uuidToBytes(device))
  })

  it('remembers a bounded window of ids', () => {
    const recent = new RecentIds([], 2)
    recent.add('a')
    recent.add('b')
    recent.add('b')
    recent.add('c')
    expect(recent.has('a')).toBe(false)
    expect(recent.has('c')).toBe(true)
    expect(new RecentIds(recent.toJSON()).has('b')).toBe(true)
  })
})

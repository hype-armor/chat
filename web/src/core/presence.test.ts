import { describe, expect, it } from 'vitest'
import { MAX_PRESENCE_LEASE_MS, PresenceLeases, PresenceReconciler } from './presence'

const allow = () => true
const now = 100_000

describe('transient presence leases', () => {
  it('defaults to unknown and aggregates live devices without treating expiry as offline', () => {
    const leases = new PresenceLeases()
    expect(leases.get('alice', now, allow)).toBe('unknown')
    leases.update('phone', 'alice', 'away', now, now + 10_000, now)
    leases.update('laptop', 'alice', 'online', now, now + 5_000, now)
    expect(leases.get('alice', now, allow)).toBe('online')
    expect(leases.get('alice', now + 5_000, allow)).toBe('away')
    expect(leases.get('alice', now + 10_000, allow)).toBe('unknown')
  })

  it('rejects stale, future, overlong and malformed events', () => {
    const leases = new PresenceLeases()
    leases.update('a', 'alice', 'online', now - MAX_PRESENCE_LEASE_MS - 1, now + 1, now)
    leases.update('b', 'alice', 'online', now + 2_001, now + 3_000, now)
    leases.update('c', 'alice', 'online', now, now + MAX_PRESENCE_LEASE_MS + 1, now)
    leases.update('d', 'alice', 'online', NaN, now + 1, now)
    expect(leases.get('alice', now, allow)).toBe('unknown')
  })

  it('keeps a stop fence against delayed starts and prevents device identity changes', () => {
    const leases = new PresenceLeases()
    leases.update('phone', 'alice', 'online', now, now + 20_000, now)
    leases.update('phone', 'alice', 'unknown', now + 1, now + 20_000, now + 1)
    leases.update('phone', 'alice', 'online', now + 1, now + 20_000, now + 1)
    leases.update('phone', 'bob', 'online', now + 2, now + 20_000, now + 2)
    expect(leases.get('alice', now + 2, allow)).toBe('unknown')
    expect(leases.get('bob', now + 2, allow)).toBe('unknown')
  })

  it('drops disallowed devices and clears state across sessions', () => {
    const leases = new PresenceLeases()
    leases.update('phone', 'alice', 'online', now, now + 20_000, now)
    expect(leases.get('alice', now, () => false)).toBe('unknown')
    expect(leases.get('alice', now, allow)).toBe('unknown')
    leases.update('phone', 'alice', 'away', now + 1, now + 20_000, now + 1)
    leases.clear()
    expect(leases.get('alice', now + 1, allow)).toBe('unknown')
  })

  it('does not revive an expired lease on clock rollback', () => {
    const leases = new PresenceLeases()
    leases.update('phone', 'alice', 'online', now, now + 1_000, now)
    expect(leases.get('alice', now + 1_001, allow)).toBe('unknown')
    expect(leases.get('alice', now, allow)).toBe('unknown')
  })
})


describe('experimental presence reconciliation', () => {
  const event = (device = 'phone', generation = '1') => ({
    account: 'alice', device, generation, state: 'online' as const,
    sentAt: now, expiresAt: now + 10_000,
  })

  it('fences delayed polls and requires an independent current generation', () => {
    const r = new PresenceReconciler('alice')
    const old = r.begin()
    const current = r.begin()
    expect(r.apply(current, '2', [event('phone', '1'), event('laptop', '2')], now, allow)).toBe(true)
    expect(r.apply(old, '1', [event()], now, allow)).toBe(false)
    expect(r.get(now, allow)).toBe('online')
    const revoked = r.begin()
    expect(r.get(now, allow)).toBe('unknown')
    expect(r.apply(revoked, null, [event('laptop', '2')], now, allow)).toBe(false)
    expect(r.apply(r.begin(), '2', [event('laptop', '2')], now, allow)).toBe(false)
    expect(r.apply(r.begin(), '3', [event('laptop', '2')], now, allow)).toBe(true)
    expect(r.get(now, allow)).toBe('unknown')
  })

  it('removes omitted and expired devices without resurrecting their old lease', () => {
    const r = new PresenceReconciler('alice')
    r.apply(r.begin(), '1', [event()], now, allow)
    r.apply(r.begin(), '1', [], now + 1, allow)
    r.apply(r.begin(), '1', [event()], now + 2, allow)
    expect(r.get(now + 2, allow)).toBe('unknown')
    const fresh = { ...event(), sentAt: now + 3, expiresAt: now + 4 }
    r.apply(r.begin(), '1', [fresh], now + 3, allow)
    expect(r.get(now + 4, allow)).toBe('unknown')
    r.apply(r.begin(), '1', [fresh], now + 5, allow)
    expect(r.get(now, allow)).toBe('unknown')
  })

  it('fails closed on errors, invalid events, roster changes and stale generations', () => {
    const r = new PresenceReconciler('alice')
    r.apply(r.begin(), '5', [event('phone', '5')], now, allow)
    const pending = r.begin()
    r.fail(pending)
    expect(r.apply(pending, '5', [event('phone', '5')], now, allow)).toBe(false)
    expect(r.apply(r.begin(), '4', [event('phone', '4')], now, allow)).toBe(false)
    r.apply(r.begin(), '5', [{ ...event('phone', '5'), account: 'bob' }], now, allow)
    expect(r.get(now, allow)).toBe('unknown')
    r.apply(r.begin(), '5', [event('phone', '5')], now, () => false)
    expect(r.get(now, allow)).toBe('unknown')
    r.invalidate()
    expect(r.get(now, allow)).toBe('unknown')
  })

  it('checks every device even when an earlier device is online', () => {
    const leases = new PresenceLeases()
    leases.update('first', 'alice', 'online', now, now + 10_000, now)
    leases.update('removed', 'alice', 'away', now, now + 10_000, now)
    expect(leases.get('alice', now, device => device !== 'removed')).toBe('online')
    expect(leases.get('alice', now + 1, device => device !== 'first')).toBe('unknown')
  })
})

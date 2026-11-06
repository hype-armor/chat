import { describe, expect, it } from 'vitest'
import { TypingLeases } from './typing'

const now = 50_000
const allow = () => true

describe('encrypted typing leases', () => {
  it('deduplicates devices by account and keeps other typists independent', () => {
    const leases = new TypingLeases()
    leases.update('a1', 'Alex', true, now, now + 8_000, now)
    leases.update('a2', 'Alex', true, now, now + 8_000, now)
    leases.update('b1', 'Blair', true, now, now + 8_000, now)
    expect(leases.accounts(now, allow)).toEqual(['Alex', 'Blair'])
    leases.update('a1', 'Alex', false, now + 1, now + 8_001, now + 1)
    expect(leases.accounts(now + 1, allow)).toEqual(['Alex', 'Blair'])
    leases.stopDevice('a2', 'Alex', now + 1, now + 1)
    expect(leases.accounts(now + 1, allow)).toEqual(['Blair'])
    expect(leases.accounts(now + 8_001, allow)).toEqual([])
  })

  it('rejects old, invalid, oversized, future, and expired events', () => {
    const leases = new TypingLeases()
    for (const [sent, expires] of [[now, now], [now, now + 10_001], [now + 2_001, now + 3_000], [NaN, now + 1], [now - 10_001, now + 1], [now - 1, now]]) {
      leases.update('a1', 'Alex', true, sent, expires, now)
    }
    expect(leases.accounts(now, allow)).toEqual([])
    leases.update('a1', 'Alex', true, now, now + 10_000, now)
    expect(leases.accounts(now, allow)).toEqual(['Alex'])
  })

  it('does not revive stopped devices through reordering or equal timestamps', () => {
    const leases = new TypingLeases()
    leases.update('a1', 'Alex', false, now + 1, now + 8_001, now + 1)
    leases.update('a1', 'Alex', true, now, now + 8_000, now + 1)
    leases.update('a1', 'Alex', true, now + 1, now + 8_001, now + 1)
    expect(leases.accounts(now + 1, allow)).toEqual([])
    expect(leases.empty(now + 2)).toBe(false)
    expect(leases.empty(now + 10_002)).toBe(true)
  })

  it('retains tombstones through the future-skew horizon and rejects replay after clock rollback', () => {
    const leases = new TypingLeases()
    const sentAt = now + 2_000
    leases.update('a1', 'Alex', false, sentAt, sentAt + 10_000, now)
    for (const time of [sentAt + 9_999, sentAt + 10_000]) {
      leases.update('a1', 'Alex', true, sentAt - 1, sentAt + 9_999, time)
      expect(leases.accounts(time, allow)).toEqual([])
      expect(leases.empty(time)).toBe(false)
    }
    expect(leases.empty(sentAt + 10_001)).toBe(true)
    leases.update('a1', 'Alex', true, sentAt - 1, sentAt + 9_999, now)
    expect(leases.accounts(now, allow)).toEqual([])
  })

  it('prunes removed and blocked devices', () => {
    const leases = new TypingLeases()
    leases.update('a1', 'Alex', true, now, now + 8_000, now)
    expect(leases.accounts(now, () => false)).toEqual([])
    expect(leases.empty(now)).toBe(true)
  })
})

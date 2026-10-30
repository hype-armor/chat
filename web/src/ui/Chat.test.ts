import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../core/protocol'
import { dayLabel, messageLayout, parseUsernames } from './Chat'

const now = new Date(2026, 9, 30, 12).getTime()
const message = (from: string, sentAt = now, kind?: 'notice'): ChatMessage => ({
  id: `${from}-${sentAt}`,
  from,
  sentAt,
  kind,
  text: 'Hello',
  status: from === 'me' ? 'sent' : 'received',
})

describe('dayLabel', () => {
  it('labels local calendar days, not elapsed 24-hour periods', () => {
    const midnight = new Date(2026, 9, 30, 0, 1).getTime()
    expect(dayLabel(midnight, now)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 29, 23, 59).getTime(), midnight)).toBe('Yesterday')
    const older = new Date(2025, 11, 31, 12)
    expect(dayLabel(older.getTime(), now)).toBe(
      older.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }),
    )
  })

  it('handles month and year boundaries', () => {
    expect(dayLabel(new Date(2025, 11, 31, 23).getTime(), new Date(2026, 0, 1, 1).getTime())).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 8, 30, 23).getTime(), new Date(2026, 9, 1, 1).getTime())).toBe('Yesterday')
  })
})

describe('messageLayout', () => {
  it('handles empty and single-message histories', () => {
    expect(messageLayout([], now)).toEqual([])
    const m = message('me')
    expect(messageLayout([m], now)).toEqual([{ message: m, day: 'Today', first: true, last: true }])
  })

  it('joins consecutive messages up to three minutes apart, including equal timestamps', () => {
    const layout = messageLayout([
      message('me'), message('me'), message('me', now + 180_000), message('me', now + 360_001),
    ], now)
    expect(layout.map(({ first, last, day }) => ({ first, last, day }))).toEqual([
      { first: true, last: false, day: 'Today' },
      { first: false, last: false, day: undefined },
      { first: false, last: true, day: undefined },
      { first: true, last: true, day: undefined },
    ])
  })

  it('breaks runs for sender changes, notices, and backwards timestamps', () => {
    const layout = messageLayout([
      message('alice'), message('bob'), message('bob', now, 'notice'), message('bob'), message('bob', now - 1),
    ], now)
    expect(layout.every(({ first, last }) => first && last)).toBe(true)
    expect(layout.filter(({ day }) => day)).toHaveLength(1)
  })

  it('separates local days even for the same sender within three minutes', () => {
    const layout = messageLayout([
      message('alice', new Date(2026, 9, 29, 23, 59).getTime()),
      message('alice', new Date(2026, 9, 30, 0, 1).getTime()),
      message('alice', new Date(2026, 9, 30, 0, 2).getTime()),
    ], now)
    expect(layout.map(({ day }) => day)).toEqual(['Yesterday', 'Today', undefined])
    expect(layout.map(({ first, last }) => [first, last])).toEqual([[true, true], [true, false], [false, true]])
  })

  it('includes notices in day boundaries without treating them as bubbles', () => {
    const layout = messageLayout([message('', now, 'notice'), message('alice')], now)
    expect(layout.map(({ day }) => day)).toEqual(['Today', undefined])
    expect(layout.every(({ first, last }) => first && last)).toBe(true)
  })
})

describe('parseUsernames', () => {
  it('accepts commas, spaces and new lines', () => {
    expect(parseUsernames('alex.27, sam.04\nkim.10 ;')).toEqual([
      'alex.27',
      'sam.04',
      'kim.10',
    ])
    expect(parseUsernames('  ')).toEqual([])
  })
})

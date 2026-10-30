import { describe, expect, it } from 'vitest'
import { type CallRecord, callNotice, formatCallDuration } from './calls'

const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  conversationId: 'c',
  outgoing: false,
  video: false,
  startedAt: 0,
  ...over,
})

describe('call notices', () => {
  it('shows the length of answered calls', () => {
    expect(callNotice(call({ answeredAt: 1_000 }), 'hangup', false, 63_000)).toEqual({
      text: '📞 Voice call · 1:02',
      missed: false,
    })
    expect(callNotice(call({ video: true, outgoing: true, answeredAt: 0 }), 'hangup', true, 5_000).text).toBe(
      '🎥 Video call · 0:05',
    )
  })

  it('counts unanswered incoming calls as missed', () => {
    expect(callNotice(call(), 'hangup', false, 10)).toEqual({ text: '📞 Missed voice call', missed: true })
    expect(callNotice(call(), 'timeout', false, 10).missed).toBe(true)
    // Busy on another call here: still missed.
    expect(callNotice(call(), 'busy', true, 10).missed).toBe(true)
    expect(callNotice(call(), 'decline', true, 10)).toEqual({ text: '📞 Declined voice call', missed: false })
  })

  it('tells the caller how it ended', () => {
    const out = call({ outgoing: true, video: true })
    expect(callNotice(out, 'decline', false, 1).text).toBe('🎥 Video call declined')
    expect(callNotice(out, 'busy', false, 1).text).toBe('🎥 Video call: line busy')
    expect(callNotice(out, 'hangup', true, 1).text).toBe('🎥 Cancelled video call')
    expect(callNotice(out, 'hangup', true, 45_000).text).toBe('🎥 Video call: no answer')
    expect(callNotice(out, 'timeout', false, 1).text).toBe('🎥 Video call: no answer')
  })

  it('notes calls handled on another device', () => {
    expect(callNotice(call({ answeredAt: 0, elsewhere: 'answered' }), 'hangup', false, 9).text).toBe(
      '📞 Voice call answered on another device',
    )
    expect(callNotice(call({ elsewhere: 'declined' }), 'decline', true, 9).missed).toBe(false)
  })

  it('formats durations', () => {
    expect(formatCallDuration(0)).toBe('0:00')
    expect(formatCallDuration(725_000)).toBe('12:05')
    expect(formatCallDuration(3_729_000)).toBe('1:02:09')
  })
})

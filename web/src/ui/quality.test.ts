import { describe, expect, it } from 'vitest'
import { measure, rate } from './quality'

describe('call quality', () => {
  it('rates loss and latency', () => {
    expect(rate(undefined, undefined)).toBe('good')
    expect(rate(0.02, 120)).toBe('good')
    expect(rate(0.15, 50)).toBe('poor')
    expect(rate(0, 900)).toBe('poor')
  })

  it('reads the reports browsers give', () => {
    const report = new Map<string, Record<string, unknown>>([
      ['a', { type: 'remote-inbound-rtp', fractionLost: 0.1 }],
      ['b', { type: 'remote-inbound-rtp', fractionLost: 0.02 }],
      ['c', { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.25 }],
      ['d', { type: 'candidate-pair', nominated: false, currentRoundTripTime: 3 }],
    ]) as unknown as RTCStatsReport
    expect(measure(report)).toEqual({ loss: 0.1, rttMs: 250 })
  })
})

import { describe, expect, it } from 'vitest'
import { commitWasAccepted, retryDelay, sendOutcome, throwUnlessAccepted } from './commits'

describe('commitWasAccepted', () => {
  it('only when the server recorded exactly our commit', () => {
    expect(commitWasAccepted('abc=', 'abc=')).toBe(true)
    expect(commitWasAccepted('abc=', 'xyz=')).toBe(false)
    expect(commitWasAccepted('abc=', undefined)).toBe(false)
  })
})

describe('throwUnlessAccepted', () => {
  it('explains each outcome', () => {
    expect(() => throwUnlessAccepted('accepted', 'x')).not.toThrow()
    expect(() => throwUnlessAccepted('lost', 'adding people')).toThrow(/Connection lost while adding people/)
    expect(() => throwUnlessAccepted('conflict', 'x')).toThrow(/same moment/)
    expect(() => throwUnlessAccepted('limited', 'x')).toThrow(/try again later/)
    expect(() => throwUnlessAccepted('rejected', 'removing them')).toThrow(/Could not finish removing them/)
  })
})

describe('retryDelay', () => {
  it('doubles from 5 s and caps at 2 min', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000])
  })
})

describe('sendOutcome', () => {
  it('retries rate limits and server trouble, explains refusals', () => {
    expect(sendOutcome({ kind: 'send_result', accepted: true })).toEqual({ kind: 'sent' })
    for (const errorCode of [429, 500, 503]) expect(sendOutcome({ kind: 'error', errorCode })).toEqual({ kind: 'retry' })
    expect(sendOutcome({ kind: 'error', errorCode: 403 })).toEqual({
      kind: 'failed',
      reason: "You're no longer in this conversation",
    })
    expect(sendOutcome({ kind: 'error', errorCode: 400 }).kind).toBe('failed')
    expect(sendOutcome({ kind: 'send_result', accepted: false }).kind).toBe('failed')
  })
})

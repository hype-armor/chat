import { describe, expect, it } from 'vitest'
import { commitWasAccepted, throwUnlessAccepted } from './commits'

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
    expect(() => throwUnlessAccepted('rejected', 'removing them')).toThrow(/Could not finish removing them/)
  })
})

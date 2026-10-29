import { describe, expect, it } from 'vitest'
import { commitWasAccepted } from './commits'

describe('commitWasAccepted', () => {
  it('only when the server recorded exactly our commit', () => {
    expect(commitWasAccepted('abc=', 'abc=')).toBe(true)
    expect(commitWasAccepted('abc=', 'xyz=')).toBe(false)
    expect(commitWasAccepted('abc=', undefined)).toBe(false)
  })
})

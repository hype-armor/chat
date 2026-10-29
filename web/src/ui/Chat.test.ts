import { describe, expect, it } from 'vitest'
import { parseUsernames } from './Chat'

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

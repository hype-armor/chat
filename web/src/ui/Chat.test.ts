import { describe, expect, it } from 'vitest'
import { parsePhones } from './Chat'

describe('parsePhones', () => {
  it('accepts commas, spaces and new lines', () => {
    expect(parsePhones('+15550001111, +15550002222\n+15550003333 ;')).toEqual([
      '+15550001111',
      '+15550002222',
      '+15550003333',
    ])
    expect(parsePhones('  ')).toEqual([])
  })
})

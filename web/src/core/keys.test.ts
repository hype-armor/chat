import { describe, expect, it } from 'vitest'
import { formatSafetyNumber, observeKeys, scannedMatches, verification, verifyText } from './keys'

describe('observeKeys', () => {
  it('trusts the first keys seen and reports new ones after that', () => {
    const book = {}
    expect(observeKeys(book, 'bob', ['k1'])).toEqual([])
    expect(observeKeys(book, 'bob', ['k1'])).toEqual([])
    expect(observeKeys(book, 'bob', ['k1', 'k2'])).toEqual(['k2'])
    // Seeing a subset (a group the new device hasn't joined yet) is not a change.
    expect(observeKeys(book, 'bob', ['k1'])).toEqual([])
    expect(book).toEqual({ bob: ['k1', 'k2'] })
  })
})

describe('verification', () => {
  it('holds until a key outside the verified set appears', () => {
    expect(verification(undefined, ['k1'])).toBe('unverified')
    expect(verification(['k1', 'k2'], ['k1'])).toBe('verified')
    expect(verification(['k1'], ['k1', 'k2'])).toBe('changed')
  })
})

describe('safety number presentation', () => {
  const digits = '0123456789'.repeat(6)
  it('groups digits in fives', () => {
    expect(formatSafetyNumber(digits).split(' ')).toHaveLength(12)
    expect(formatSafetyNumber(digits).startsWith('01234 56789 ')).toBe(true)
  })
  it('matches scanned codes exactly', () => {
    expect(scannedMatches(verifyText(digits), digits)).toBe(true)
    expect(scannedMatches(verifyText(digits.replace('0', '1')), digits)).toBe(false)
    expect(scannedMatches(digits, digits)).toBe(false)
  })
})

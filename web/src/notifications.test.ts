import { describe, expect, it } from 'vitest'
import { base64UrlToBytes } from './notifications'

describe('base64UrlToBytes', () => {
  it('decodes unpadded base64url', () => {
    expect(Array.from(base64UrlToBytes('AQID'))).toEqual([1, 2, 3])
    expect(Array.from(base64UrlToBytes('-_8'))).toEqual([251, 255])
    expect(base64UrlToBytes('B'.repeat(87)).length).toBe(65) // VAPID public key size
  })
})

import { describe, expect, it } from 'vitest'
import { MAX_AVATAR_BYTES, isAvatar } from './avatar'

describe('isAvatar', () => {
  it('accepts a JPEG of an acceptable size', () => {
    expect(isAvatar(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe(true)
  })
  it('refuses other formats, empty and oversized pictures', () => {
    expect(isAvatar(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
    expect(isAvatar(new Uint8Array())).toBe(false)
    const big = new Uint8Array(MAX_AVATAR_BYTES + 1)
    big.set([0xff, 0xd8, 0xff])
    expect(isAvatar(big)).toBe(false)
  })
})

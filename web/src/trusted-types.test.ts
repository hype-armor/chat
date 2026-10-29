import { describe, expect, it } from 'vitest'
import { sameOriginScriptUrl } from './trusted-types'

describe('sameOriginScriptUrl', () => {
  const base = 'https://chat.example/app'
  it('resolves same-origin URLs', () => {
    expect(sameOriginScriptUrl('/sw.js', base)).toBe('https://chat.example/sw.js')
    expect(sameOriginScriptUrl('assets/worker.js', base)).toBe('https://chat.example/assets/worker.js')
  })
  it('rejects other origins', () => {
    expect(() => sameOriginScriptUrl('https://evil.example/x.js', base)).toThrow(/cross-origin/)
    expect(() => sameOriginScriptUrl('//evil.example/x.js', base)).toThrow(/cross-origin/)
  })
})

import { describe, expect, it } from 'vitest'
import { installHint, isIosSafari, storageAdvice } from './pwa'

const iphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

describe('install hint', () => {
  it('detects iOS Safari only', () => {
    expect(isIosSafari(iphone)).toBe(true)
    expect(isIosSafari(iphone.replace('Version/18.0', 'CriOS/130.0'))).toBe(false)
    expect(isIosSafari('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36')).toBe(false)
  })
  it('prefers the browser prompt, else the iOS steps, never when installed', () => {
    expect(installHint({ installed: false, promptAvailable: true, iosSafari: false })).toBe('prompt')
    expect(installHint({ installed: false, promptAvailable: false, iosSafari: true })).toBe('ios')
    expect(installHint({ installed: false, promptAvailable: false, iosSafari: false })).toBeUndefined()
    expect(installHint({ installed: true, promptAvailable: true, iosSafari: true })).toBeUndefined()
  })
})

describe('storage advice', () => {
  it('asks once, warns if denied', () => {
    expect(storageAdvice('ask')).toBe('ask')
    expect(storageAdvice('denied')).toBe('warn')
    expect(storageAdvice('persisted')).toBeUndefined()
    expect(storageAdvice('unsupported')).toBeUndefined()
  })
})

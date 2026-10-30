import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SETUP_REMINDER_MS,
  installHint,
  isIosSafari,
  readSetupDismissals,
  saveSetupDismissals,
  setupBanner,
  storageAdvice,
} from './pwa'

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

  describe('setup banner priority and dismissal', () => {
    const now = 2 * SETUP_REMINDER_MS
    const base = { install: 'prompt' as const, dismissed: {}, now }

    it('waits for storage, then prefers storage warnings and requests over install', () => {
      expect(setupBanner(base)).toBeUndefined()
      expect(setupBanner({ ...base, storage: 'denied' })).toBe('storage-warn')
      expect(setupBanner({ ...base, storage: 'ask' })).toBe('storage-ask')
      expect(setupBanner({ ...base, storage: 'persisted' })).toBe('install')
      expect(setupBanner({ ...base, storage: 'unsupported', install: 'ios' })).toBe('install')
      expect(setupBanner({ ...base, storage: 'persisted', install: undefined })).toBeUndefined()
    })

    it('skips dismissed banners without hiding other reminders', () => {
      const dismissed = { 'storage-ask': now, install: now }
      expect(setupBanner({ ...base, storage: 'ask', dismissed: { 'storage-ask': now } })).toBe('install')
      expect(setupBanner({ ...base, storage: 'ask', dismissed })).toBeUndefined()
      expect(setupBanner({ ...base, storage: 'denied', dismissed })).toBe('storage-warn')
      expect(setupBanner({ ...base, storage: 'denied', dismissed: { 'storage-warn': now } })).toBe('install')
    })

    it('reminds again after 14 days, not before', () => {
      const dismissed = { 'storage-ask': now - SETUP_REMINDER_MS + 1, install: now }
      expect(setupBanner({ ...base, storage: 'ask', dismissed })).toBeUndefined()
      expect(setupBanner({ ...base, storage: 'ask', dismissed, now: now + 1 })).toBe('storage-ask')
    })

    it('does not suppress reminders for invalid or future timestamps', () => {
      for (const at of [NaN, Infinity, -1, now + 1]) {
        expect(setupBanner({ ...base, storage: 'ask', dismissed: { 'storage-ask': at } })).toBe('storage-ask')
      }
    })
  })

  describe('device-local setup preferences', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('round-trips dismissal timestamps across sessions', () => {
      const values = new Map<string, string>()
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      })
      expect(readSetupDismissals()).toEqual({})
      saveSetupDismissals({ 'storage-ask': 123, install: 456 })
      expect(readSetupDismissals()).toEqual({ 'storage-ask': 123, install: 456 })
    })

    it('ignores malformed data and keeps only valid preference fields', () => {
      for (const value of ['not json', 'null', '[]', '"text"', '42']) {
        vi.stubGlobal('localStorage', { getItem: () => value })
        expect(readSetupDismissals()).toEqual({})
      }
      vi.stubGlobal('localStorage', {
        getItem: () => '{"storage-ask":123,"storage-warn":"456","install":-1,"extra":789}',
      })
      expect(readSetupDismissals()).toEqual({ 'storage-ask': 123 })
    })

    it('tolerates unavailable localStorage', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => { throw new Error('blocked') },
        setItem: () => { throw new Error('quota exceeded') },
      })
      expect(readSetupDismissals()).toEqual({})
      expect(() => saveSetupDismissals({ install: 123 })).not.toThrow()
    })
  })
})

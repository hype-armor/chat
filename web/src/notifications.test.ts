import { afterEach, describe, expect, it, vi } from 'vitest'
import { base64UrlToBytes, notificationState, usesApplicationKey } from './notifications'

describe('base64UrlToBytes', () => {
  it('decodes unpadded base64url', () => {
    expect(Array.from(base64UrlToBytes('AQID'))).toEqual([1, 2, 3])
    expect(Array.from(base64UrlToBytes('-_8'))).toEqual([251, 255])
    expect(base64UrlToBytes('B'.repeat(87)).length).toBe(65) // VAPID public key size
  })
})

describe('usesApplicationKey', () => {
  const subscriptionWith = (key: Uint8Array | null) =>
    ({ options: { applicationServerKey: key?.buffer ?? null } }) as unknown as PushSubscription

  it('matches only the server key the subscription was made with', () => {
    const key = new Uint8Array([1, 2, 3])
    expect(usesApplicationKey(subscriptionWith(new Uint8Array([1, 2, 3])), key)).toBe(true)
    expect(usesApplicationKey(subscriptionWith(new Uint8Array([1, 2, 4])), key)).toBe(false)
    expect(usesApplicationKey(subscriptionWith(new Uint8Array([1, 2])), key)).toBe(false)
    expect(usesApplicationKey(subscriptionWith(null), key)).toBe(false)
  })
})

describe('notificationState', () => {
  afterEach(() => vi.unstubAllGlobals())

  const installBrowser = (options: { ios?: boolean; installed?: boolean; standalone?: boolean; push?: boolean } = {}) => {
    const permission = { permission: 'default' }
    vi.stubGlobal('Notification', permission)
    vi.stubGlobal('window', {
      Notification: permission,
      ...(options.push === false ? {} : { PushManager: {} }),
      matchMedia: () => ({ matches: options.installed ?? false }),
    })
    vi.stubGlobal('navigator', {
      userAgent: options.ios ? 'iPhone Safari' : 'Desktop Chrome',
      platform: options.ios ? 'iPhone' : 'Linux x86_64',
      maxTouchPoints: options.ios ? 5 : 0,
      standalone: options.standalone ?? options.installed ?? false,
      serviceWorker: {},
    })
  }

  it('requires a Home Screen install before an iPhone can enable push', () => {
    installBrowser({ ios: true })
    expect(notificationState()).toBe('install-required')
  })

  it('reports the permission state inside the installed PWA', () => {
    installBrowser({ ios: true, installed: true })
    expect(notificationState()).toBe('default')
  })

  it('uses navigator.standalone when Safari does not expose display-mode', () => {
    installBrowser({ ios: true, standalone: true })
    expect(notificationState()).toBe('default')
  })

  it('shows install guidance even when Safari hides Push APIs in browser tabs', () => {
    installBrowser({ ios: true, push: false })
    expect(notificationState()).toBe('install-required')
  })

  it('reports unsupported push APIs', () => {
    installBrowser({ push: false })
    expect(notificationState()).toBe('unsupported')
  })
})

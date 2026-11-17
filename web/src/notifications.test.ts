import { afterEach, describe, expect, it, vi } from 'vitest'
import { base64UrlToBytes, notificationState, resetNotificationSubscription, resetNotificationWorker, usesApplicationKey } from './notifications'

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

describe('resetNotificationSubscription', () => {
  it('replaces a browser subscription before uploading it', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true)
    const replacement = { toJSON: () => ({ endpoint: 'https://web.push.apple.com/new' }) }
    const subscribe = vi.fn().mockResolvedValue(replacement)
    const registration = {
      pushManager: { getSubscription: vi.fn().mockResolvedValue({ unsubscribe }), subscribe },
    } as unknown as ServiceWorkerRegistration
    const enablePush = vi.fn().mockResolvedValue(undefined)

    await resetNotificationSubscription(
      { enablePush } as never,
      { registration, applicationServerKey: new Uint8Array([1, 2, 3]) },
    )

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) })
    expect(enablePush).toHaveBeenCalledWith({ endpoint: 'https://web.push.apple.com/new' })
  })
})

describe('resetNotificationWorker', () => {
  afterEach(() => vi.unstubAllGlobals())

  const installWorker = () => {
    const order: string[] = []
    const unsubscribe = vi.fn(async () => { order.push('unsubscribe'); return true })
    const unregister = vi.fn(async () => { order.push('unregister'); return true })
    const getSubscription = vi.fn().mockResolvedValue({ unsubscribe })
    const getRegistration = vi.fn().mockResolvedValue({ pushManager: { getSubscription }, unregister })
    const reload = vi.fn(() => { order.push('reload') })
    const clear = vi.fn(() => { throw new Error('Site storage must not be cleared') })
    const removeItem = vi.fn(() => { throw new Error('Stored identity must not be removed') })
    const deleteDatabase = vi.fn(() => { throw new Error('Encrypted databases must not be deleted') })
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration } })
    vi.stubGlobal('window', {
      location: { reload },
      localStorage: { clear, removeItem },
      sessionStorage: { clear, removeItem },
      indexedDB: { deleteDatabase },
    })
    vi.stubGlobal('localStorage', { clear, removeItem })
    vi.stubGlobal('sessionStorage', { clear, removeItem })
    vi.stubGlobal('indexedDB', { deleteDatabase })
    return { order, unsubscribe, unregister, getSubscription, getRegistration, reload, clear, removeItem, deleteDatabase }
  }

  it('unsubscribes, unregisters the current worker, and reloads without deleting local data', async () => {
    const browser = installWorker()
    await resetNotificationWorker()
    expect(browser.order).toEqual(['unsubscribe', 'unregister', 'reload'])
    expect(browser.getRegistration).toHaveBeenCalledWith()
    expect(browser.clear).not.toHaveBeenCalled()
    expect(browser.removeItem).not.toHaveBeenCalled()
    expect(browser.deleteDatabase).not.toHaveBeenCalled()
  })

  it('can reset a worker that has no subscription', async () => {
    const browser = installWorker()
    browser.getSubscription.mockResolvedValue(null)
    await resetNotificationWorker()
    expect(browser.order).toEqual(['unregister', 'reload'])
    expect(browser.unsubscribe).not.toHaveBeenCalled()
  })

  it('does not reload when the current worker is absent', async () => {
    const browser = installWorker()
    browser.getRegistration.mockResolvedValue(undefined)
    await expect(resetNotificationWorker()).rejects.toThrow('Chat needs a service worker')
    expect(browser.unregister).not.toHaveBeenCalled()
    expect(browser.reload).not.toHaveBeenCalled()
  })

  it.each(['refused', 'rejected'] as const)('does not unregister or reload when unsubscribe is %s', async (failure) => {
    const browser = installWorker()
    if (failure === 'refused') browser.unsubscribe.mockResolvedValue(false)
    else browser.unsubscribe.mockRejectedValue(new Error('unsubscribe failed'))
    await expect(resetNotificationWorker()).rejects.toThrow()
    expect(browser.unregister).not.toHaveBeenCalled()
    expect(browser.reload).not.toHaveBeenCalled()
  })

  it.each(['refused', 'rejected'] as const)('does not reload when unregister is %s', async (failure) => {
    const browser = installWorker()
    if (failure === 'refused') browser.unregister.mockResolvedValue(false)
    else browser.unregister.mockRejectedValue(new Error('unregister failed'))
    await expect(resetNotificationWorker()).rejects.toThrow()
    expect(browser.unsubscribe).toHaveBeenCalledOnce()
    expect(browser.reload).not.toHaveBeenCalled()
  })

  it('does not unregister or reload when subscription lookup fails', async () => {
    const browser = installWorker()
    browser.getSubscription.mockRejectedValue(new Error('subscription lookup failed'))
    await expect(resetNotificationWorker()).rejects.toThrow('subscription lookup failed')
    expect(browser.unregister).not.toHaveBeenCalled()
    expect(browser.reload).not.toHaveBeenCalled()
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

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StorageUsageView } from './ServerStorage'
import { quotaStatus, StorageLoader, storageBytes, type StorageState } from './serverStorage'

const usage = { usedBytes: 60, reservedBytes: 30, limitBytes: 100 }
const render = (state: StorageState) => renderToStaticMarkup(createElement(StorageUsageView, { state, refresh: () => {} }))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('server storage settings', () => {
  it('loads usage and disables duplicate refreshes', async () => {
    const request = deferred<typeof usage>()
    const core = { storageUsage: vi.fn(() => request.promise) }
    const loader = new StorageLoader(core)
    const changed = vi.fn()
    const unsubscribe = loader.subscribe(changed)
    const loading = loader.refresh()
    await loader.refresh()
    expect(core.storageUsage).toHaveBeenCalledTimes(1)
    expect(loader.snapshot()).toEqual({ loading: true })
    expect(render(loader.snapshot())).toContain('Loading storage…')
    expect(render(loader.snapshot())).toContain('disabled=""')
    request.resolve(usage)
    await loading
    expect(loader.snapshot()).toEqual({ loading: false, usage })
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
  it('shows a retryable initial error and recovers', async () => {
    const core = { storageUsage: vi.fn<() => Promise<typeof usage>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(usage) }
    const loader = new StorageLoader(core)
    await loader.refresh()
    expect(loader.snapshot().error).toContain('Try again')
    const html = render(loader.snapshot())
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('Account quota')
    await loader.refresh()
    expect(loader.snapshot()).toEqual({ loading: false, usage })
  })
  it('retains and labels stale usage during refresh and failure', async () => {
    const request = deferred<typeof usage>()
    const core = { storageUsage: vi.fn().mockResolvedValueOnce(usage).mockImplementationOnce(() => request.promise) }
    const loader = new StorageLoader(core)
    await loader.refresh()
    const refreshing = loader.refresh()
    expect(render(loader.snapshot())).toContain('Refreshing storage…')
    expect(render(loader.snapshot())).toContain('Showing the last loaded usage.')
    request.reject(new Error('offline'))
    await refreshing
    expect(loader.snapshot().usage).toEqual(usage)
    expect(render(loader.snapshot())).toContain('Showing the last loaded usage.')
  })
  it('ignores responses after settings unmount and allows a fresh load', async () => {
    const old = deferred<typeof usage>()
    const core = { storageUsage: vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce({ ...usage, usedBytes: 1 }) }
    const loader = new StorageLoader(core)
    const loading = loader.refresh()
    loader.cancel()
    await loader.refresh()
    old.resolve(usage)
    await loading
    expect(loader.snapshot().usage?.usedBytes).toBe(1)
  })
  it('shows separate used bytes, reservations, and the effective account quota', () => {
    const html = render({ loading: false, usage })
    expect(html).toContain('Used</dt><dd><span title="60 bytes">60 B')
    expect(html).toContain('Reserved for uploads</dt><dd><span title="30 bytes">30 B')
    expect(html).toContain('Account quota</dt><dd><span title="100 bytes">100 B')
    expect(html).toContain('value="90"')
    expect(html).toContain('Storage is almost full')
  })
  it('shows unlimited quota without a progress bar or quota warning', () => {
    const unlimited = { ...usage, limitBytes: null }
    expect(quotaStatus(unlimited)).toBe('unlimited')
    const html = render({ loading: false, usage: unlimited })
    expect(html).toContain('Unlimited')
    expect(html).not.toContain('<progress')
    expect(html).not.toContain('storage-warning')
  })
  it.each([
    [0, 0, 0, 'full'], [0, 1, 0, 'over'],
    [60, 29, 100, 'normal'], [60, 30, 100, 'near'],
    [70, 30, 100, 'full'], [71, 30, 100, 'over'],
  ] as const)('counts reservations at the quota boundary (%i + %i / %i)', (usedBytes, reservedBytes, limitBytes, status) => {
    const value = { usedBytes, reservedBytes, limitBytes }
    expect(quotaStatus(value)).toBe(status)
    const html = render({ loading: false, usage: value })
    if (status === 'over') expect(html).toContain('Storage quota exceeded')
    if (status === 'full') expect(html).toContain('Storage quota reached')
    expect(html).not.toContain('NaN')
  })
  it('formats small and large byte counts', () => {
    expect(storageBytes(0)).toBe('0 B')
    expect(storageBytes(1024)).toBe('1 KiB')
    expect(storageBytes(2 * 1024 ** 3)).toBe('2 GiB')
  })
})

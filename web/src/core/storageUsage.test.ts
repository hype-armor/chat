import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { parseStorageUsage } from './storageUsage'

afterEach(() => vi.unstubAllGlobals())

describe('account storage API', () => {
  it('authenticates GET /v1/storage without account identifiers', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ used_bytes: 12, reserved_bytes: 3, limit_bytes: 100 })))
    vi.stubGlobal('fetch', fetch)
    expect(parseStorageUsage(await api.storageUsage('worker-token'))).toEqual({ usedBytes: 12, reservedBytes: 3, limitBytes: 100 })
    expect(fetch).toHaveBeenCalledWith('/v1/storage', { headers: { authorization: 'Bearer worker-token' } })
  })
  it('propagates server errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unavailable"}', { status: 503 })))
    await expect(api.storageUsage('token')).rejects.toEqual(new ApiError(503, 'unavailable'))
  })
  it('accepts unlimited quotas and zero limits', () => {
    expect(parseStorageUsage({ used_bytes: 0, reserved_bytes: 4, limit_bytes: null }).limitBytes).toBeNull()
    expect(parseStorageUsage({ used_bytes: 0, reserved_bytes: 0, limit_bytes: 0 }).limitBytes).toBe(0)
  })
  it.each([
    {}, null,
    { used_bytes: -1, reserved_bytes: 0, limit_bytes: 10 },
    { used_bytes: 1, reserved_bytes: 0.5, limit_bytes: 10 },
    { used_bytes: 1, reserved_bytes: 0, limit_bytes: -1 },
    { used_bytes: 1, reserved_bytes: 0 },
    { used_bytes: Number.MAX_SAFE_INTEGER, reserved_bytes: 1, limit_bytes: null },
  ])('rejects malformed usage: %j', (raw) => {
    expect(() => parseStorageUsage(raw)).toThrow('invalid storage usage')
  })
})

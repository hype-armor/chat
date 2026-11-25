import { describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { Engine } from './engine'

const id = '11111111-1111-1111-1111-111111111111'

function setup() {
  const engine = new Engine(() => {})
  engine['account'] = { accountId: id, deviceId: id, token: 'token', username: 'old.01', displayName: 'Alice' }
  engine['core'] = {} as NonNullable<Engine['core']>
  engine['store'] = { putJson: vi.fn(async () => {}) } as unknown as Engine['store']
  return engine
}

describe('authoritative username', () => {
  it('updates only the username for the active account', async () => {
    const engine = setup()
    const call = vi.spyOn(api, 'currentAccount').mockResolvedValue({ account_id: id, username: 'new.02' })
    try {
      await engine['refreshUsername']()
      expect(engine['account']).toMatchObject({ accountId: id, username: 'new.02', displayName: 'Alice' })
      expect(engine['store'].putJson).toHaveBeenCalledWith('account', expect.objectContaining({ username: 'new.02' }))
    } finally { call.mockRestore() }
  })

  it('rejects a response for another account', async () => {
    const engine = setup()
    const call = vi.spyOn(api, 'currentAccount').mockResolvedValue({ account_id: '22222222-2222-2222-2222-222222222222', username: 'new.02' })
    try {
      await expect(engine['refreshUsername']()).rejects.toThrow('Invalid current account response')
      expect(engine['store'].putJson).not.toHaveBeenCalled()
    } finally { call.mockRestore() }
  })

  it('rejects a response after the session ends', async () => {
    const engine = setup()
    let resolve!: (result: { account_id: string; username: string }) => void
    const call = vi.spyOn(api, 'currentAccount').mockReturnValue(new Promise((done) => { resolve = done }))
    try {
      const pending = engine['refreshUsername']()
      await Promise.resolve()
      engine['endingSession'] = true
      resolve({ account_id: id, username: 'new.02' })
      await expect(pending).rejects.toThrow('session ended')
      expect(engine['store'].putJson).not.toHaveBeenCalled()
    } finally { call.mockRestore() }
  })

  it('persists and reuses the request ID after a lost response', async () => {
    const engine = setup()
    const rename = vi.spyOn(api, 'renameAccount').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ account_id: id, username: 'new.02' })
    const refresh = vi.spyOn(api, 'currentAccount').mockResolvedValue({ account_id: id, username: 'new.02' })
    try {
      await expect(engine.renameUsername('new.02')).rejects.toThrow('network')
      const pending = engine['account']!.pendingUsername!
      expect(engine['store'].putJson).toHaveBeenCalledWith('account', expect.objectContaining({ pendingUsername: pending }))
      await expect(engine.renameUsername('other.03')).rejects.toThrow('Retry the pending')
      await engine.renameUsername('new.02')
      expect(rename).toHaveBeenNthCalledWith(2, 'token', 'new.02', pending.requestId)
      expect(engine['account']!.pendingUsername).toBeUndefined()
      expect(engine['account']!.username).toBe('new.02')
    } finally { rename.mockRestore(); refresh.mockRestore() }
  })

  it('reports a successful rename even if the subsequent refresh fails', async () => {
    const engine = setup()
    const rename = vi.spyOn(api, 'renameAccount').mockResolvedValue({ account_id: id, username: 'new.02' })
    const refresh = vi.spyOn(api, 'currentAccount').mockRejectedValue(new Error('offline'))
    try {
      await expect(engine.renameUsername('new.02')).resolves.toBeUndefined()
      expect(engine['account']?.username).toBe('new.02')
      await engine['usernameRefresh']
    } finally { rename.mockRestore(); refresh.mockRestore() }
  })

  it('does not let an old stalled refresh block a new session', async () => {
    const engine = setup()
    engine['store'].clear = vi.fn(async () => {})
    const refresh = vi.spyOn(api, 'currentAccount')
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ account_id: id, username: 'new.02' })
    try {
      void engine['refreshUsername']()
      await Promise.resolve()
      await engine['signOut']('signed out')
      engine['endingSession'] = false
      engine['account'] = { accountId: id, deviceId: id, token: 'new-token', username: 'old.01', displayName: 'Alice' }
      engine['core'] = {} as NonNullable<Engine['core']>
      await engine['refreshUsername']()
      expect(engine['account']?.username).toBe('new.02')
    } finally { refresh.mockRestore() }
  })

  it('clears a rename rejected by an older server', async () => {
    const engine = setup()
    const rename = vi.spyOn(api, 'renameAccount').mockRejectedValue(new ApiError(404, 'not found'))
    try {
      await expect(engine.renameUsername('new.02')).rejects.toThrow('Update the server')
      expect(engine['account']?.pendingUsername).toBeUndefined()
    } finally { rename.mockRestore() }
  })

  it('keeps the request ID when a retry is rate limited', async () => {
    const engine = setup()
    const rename = vi.spyOn(api, 'renameAccount').mockRejectedValue(new ApiError(429, 'rate limited'))
    try {
      await expect(engine.renameUsername('new.02')).rejects.toThrow('rate limited')
      expect(engine['account']?.pendingUsername).toMatchObject({ username: 'new.02' })
    } finally { rename.mockRestore() }
  })

  it.each([new ApiError(429, 'rate limited'), new Error('network')])('refreshes the authoritative name after an uncertain retry fails: %s', async (error) => {
    const engine = setup()
    const pending = { username: 'new.02', requestId: 'request' }
    engine['account']!.pendingUsername = pending
    const rename = vi.spyOn(api, 'renameAccount').mockRejectedValue(error)
    // Another linked device renamed again after the original request committed.
    const refresh = vi.spyOn(api, 'currentAccount').mockResolvedValue({ account_id: id, username: 'latest.03' })
    try {
      engine['syncUsername']()
      await engine['usernameBackgroundSync']
      expect(refresh).toHaveBeenCalledWith('token')
      expect(engine['account']?.username).toBe('latest.03')
      expect(engine['account']?.pendingUsername).toEqual(pending)
      expect(engine['store'].putJson).toHaveBeenCalledWith('account', expect.objectContaining({ username: 'latest.03', pendingUsername: pending }))
    } finally { rename.mockRestore(); refresh.mockRestore() }
  })

  it('deduplicates background retries and allows a later retry after failure', async () => {
    const engine = setup()
    engine['account']!.pendingUsername = { username: 'new.02', requestId: 'request' }
    let reject!: (error: Error) => void
    const rename = vi.spyOn(engine, 'renameUsername').mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValue()
    const refresh = vi.spyOn(api, 'currentAccount').mockRejectedValue(new Error('offline'))
    try {
      engine['syncUsername']()
      engine['syncUsername']()
      expect(rename).toHaveBeenCalledTimes(1)
      reject(new Error('offline'))
      await engine['usernameBackgroundSync']
      await Promise.resolve()
      engine['syncUsername']()
      expect(rename).toHaveBeenCalledTimes(2)
      await engine['usernameBackgroundSync']
    } finally { rename.mockRestore(); refresh.mockRestore() }
  })

  it.each(['ending', 'replacement', 'epoch'] as const)('does not refresh after a failed retry from an ended session: %s', async (change) => {
    const engine = setup()
    engine['account']!.pendingUsername = { username: 'new.02', requestId: 'request' }
    let reject!: (error: Error) => void
    const rename = vi.spyOn(api, 'renameAccount').mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    const refresh = vi.spyOn(api, 'currentAccount')
    try {
      engine['syncUsername']()
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1))
      if (change === 'ending') engine['endingSession'] = true
      if (change === 'replacement') engine['account'] = { ...engine['account']!, token: 'new-token' }
      if (change === 'epoch') engine['draftEpoch'] += 1
      reject(new Error('network'))
      await engine['usernameBackgroundSync']
      expect(refresh).not.toHaveBeenCalled()
      expect(engine['account']?.username).toBe('old.01')
    } finally { rename.mockRestore(); refresh.mockRestore() }
  })

  it('does not claim keys when a renamed own account is used as a peer', async () => {
    const engine = setup()
    const lookup = vi.spyOn(api, 'lookup').mockResolvedValue({ account_id: id, device_ids: [id] })
    const claim = vi.spyOn(api, 'claim')
    try {
      await expect(engine.startChat('new.02')).rejects.toThrow("can't start a chat with yourself")
      await expect(engine['resolve'](['new.02'])).resolves.toEqual([])
      expect(claim).not.toHaveBeenCalled()
    } finally { lookup.mockRestore(); claim.mockRestore() }
  })

  it('reuses a persisted authorization after a lost prepare response', async () => {
    const engine = setup()
    engine['connection'] = 'online'
    const refresh = vi.spyOn(api, 'currentAccount').mockResolvedValue({ account_id: id, username: 'old.01' })
    const prepare = vi.spyOn(api, 'prepareAccountDeletion').mockRejectedValue(new Error('network'))
    try {
      await expect(engine.deleteAccount('old.01')).rejects.toThrow('network')
      const pending = engine['account']!.pendingDeletion!
      expect(pending.authorization).toMatch(/^[0-9a-f]{64}$/)
      expect(engine['store'].putJson).toHaveBeenCalledWith('account', expect.objectContaining({ pendingDeletion: pending }))
      engine['account']!.username = 'new.02'
      await expect(engine.deleteAccount('old.01')).rejects.toThrow('network')
      expect(prepare).toHaveBeenNthCalledWith(2, 'token', 'old.01', pending.authorization)
    } finally { refresh.mockRestore(); prepare.mockRestore() }
  })

  it('rejects a concurrent deletion while confirmation is pending', async () => {
    const engine = setup()
    engine['connection'] = 'online'
    const refresh = vi.spyOn(api, 'currentAccount').mockResolvedValue({ account_id: id, username: 'old.01' })
    let reject!: (error: Error) => void
    const prepare = vi.spyOn(api, 'prepareAccountDeletion').mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    try {
      const first = engine.deleteAccount('old.01')
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
      await expect(engine.deleteAccount('old.01')).rejects.toThrow('already in progress')
      reject(new Error('network'))
      await expect(first).rejects.toThrow('network')
    } finally { refresh.mockRestore(); prepare.mockRestore() }
  })

  it('does not repeat departures after a lost final response', async () => {
    const engine = setup()
    engine['connection'] = 'online'
    engine['account']!.pendingDeletion = { username: 'old.01', authorization: 'ab'.repeat(32), departuresComplete: true }
    const prepare = vi.spyOn(api, 'prepareAccountDeletion')
    const finish = vi.spyOn(api, 'deleteAccount').mockRejectedValue(new ApiError(401, 'invalid token'))
    try {
      await expect(engine.deleteAccount('old.01')).rejects.toThrow('may have succeeded')
      expect(prepare).not.toHaveBeenCalled()
      expect(engine['account']!.pendingDeletion).toBeDefined()
    } finally { prepare.mockRestore(); finish.mockRestore() }
  })

  it('fails safely before departures when the server lacks account refresh', async () => {
    const engine = setup()
    engine['connection'] = 'online'
    const current = vi.spyOn(api, 'currentAccount').mockRejectedValue(new ApiError(404, 'not found'))
    const prepare = vi.spyOn(api, 'prepareAccountDeletion')
    try {
      await expect(engine.deleteAccount('old.01')).rejects.toThrow('Update the server')
      expect(prepare).not.toHaveBeenCalled()
      expect(engine['account']?.pendingDeletion).toBeUndefined()
    } finally { current.mockRestore(); prepare.mockRestore() }
  })

  it('does not leave groups when current username confirmation is stale', async () => {
    const engine = setup()
    engine['connection'] = 'online'
    const call = vi.spyOn(api, 'currentAccount').mockResolvedValue({ account_id: id, username: 'new.02' })
    try {
      await expect(engine.deleteAccount('old.01')).rejects.toThrow('current username')
      expect(engine['account']?.username).toBe('new.02')
    } finally { call.mockRestore() }
  })
})

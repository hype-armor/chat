import { describe, expect, it } from 'vitest'
import { deriveBackupKeys, formatRecoveryKey, newRecoveryKey, openBackup, parseRecoveryKey, sealBackup } from './backup'

describe('recovery keys', () => {
  it('format as 26 base32 characters in groups and parse back', () => {
    const key = newRecoveryKey()
    const text = formatRecoveryKey(key)
    expect(text).toMatch(/^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/)
    expect(parseRecoveryKey(text)).toEqual(key)
    expect(parseRecoveryKey(text.toLowerCase().replaceAll('-', ' '))).toEqual(key)
  })
  it('known vector (RFC 4648)', () => {
    expect(formatRecoveryKey(new Uint8Array(16))).toBe('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA')
    expect(formatRecoveryKey(new Uint8Array(16).fill(255))).toBe('7777-7777-7777-7777-7777-7777-74')
  })
  it('rejects malformed keys', () => {
    expect(parseRecoveryKey('ABCD')).toBeUndefined()
    expect(parseRecoveryKey('0000-0000-0000-0000-0000-0000-00')).toBeUndefined()
  })
})

describe('sealed backups', () => {
  it('round-trip under the same recovery key only', async () => {
    const recovery = newRecoveryKey()
    const keys = await deriveBackupKeys(recovery)
    expect(keys.auth).toHaveLength(32)
    expect(await deriveBackupKeys(recovery).then((k) => k.auth)).toEqual(keys.auth)
    const payload = { messages: ['hello', 'world'], n: 42 }
    const sealed = await sealBackup(keys.encryption, payload)
    expect(await openBackup(keys.encryption, sealed)).toEqual(payload)
    const other = await deriveBackupKeys(newRecoveryKey())
    await expect(openBackup(other.encryption, sealed)).rejects.toThrow()
    sealed[sealed.length - 1] ^= 1
    await expect(openBackup(keys.encryption, sealed)).rejects.toThrow()
  })
})

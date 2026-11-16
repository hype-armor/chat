// Pure early-CI checks: no engine, WASM runtime, browser, or service imports.
import { describe, expect, it } from 'vitest'
import { emptyDeletions } from './deletions'
import { ME_SYNC_MAX_BYTES, meDeletionBindings, meDeletionChunks, mergeMeDeletions, parseMeDeletions, validMeBinding } from './me-deletion-sync'
const conversation = '11'.repeat(16), hash = 'aa'.repeat(32), author = '22'.repeat(16)
const binding = { conversation, hash, author }
const encode = (meDeletions: unknown) => new TextEncoder().encode(JSON.stringify({ meDeletions }))

describe('pure private Me deletion bindings', () => {
  it('requires canonical conversation, hash, and author widths', () => {
    expect(validMeBinding(binding)).toBe(true)
    for (const item of [null, [], {}, { ...binding, conversation: 'short' }, { ...binding, hash: 'bad' }, { ...binding, author: '' }, { ...binding, hash: hash.toUpperCase() }]) expect(validMeBinding(item)).toBe(false)
  })
  it('imports no JSON scope, verification, timestamp, local intent, identifier hint, or delivery status', () => {
    const data = encode([{ ...binding, scope: 'everyone', verified: true, localIntent: true, requestAt: 1, originalAt: 1, target: '33'.repeat(16), eventId: '44'.repeat(16), status: 'sending' }, binding, { ...binding, hash: 'bad' }])
    expect(parseMeDeletions(data)).toEqual([binding])
    const ledger = emptyDeletions()
    mergeMeDeletions(ledger, parseMeDeletions(data))
    expect(ledger.records).toEqual([{ scope: 'me', ...binding, target: '', aliases: [] }])
  })
  it('rejects malformed, oversized, and invalid UTF-8 frames', () => {
    for (const data of [new Uint8Array([0xff]), new TextEncoder().encode('{'), encode(null), encode({}), new Uint8Array(64 * 1024 + 1)]) expect(parseMeDeletions(data)).toEqual([])
  })
  it('keeps account-owned unknown-original records outside external candidate bounds', () => {
    const ledger = emptyDeletions()
    const records = Array.from({ length: 2_100 }, (_, i) => ({ ...binding, hash: i.toString(16).padStart(64, '0') }))
    expect(mergeMeDeletions(ledger, records)).toHaveLength(2_100)
    expect(ledger.records).toHaveLength(2_100)
    expect(ledger.candidates).toEqual([])
    expect(ledger.meSyncRevision).toBe(1)
    expect(mergeMeDeletions(ledger, records)).toEqual([])
    expect(ledger.meSyncRevision).toBe(1)
  })
  it('exports only verified Me bindings, never Everyone intents or legacy identifiers', () => {
    const ledger = emptyDeletions()
    ledger.records.push({ scope: 'everyone', ...binding, target: '33'.repeat(16), localIntent: true, requestAt: 2, originalAt: 1 }, { scope: 'me', conversation, target: '44'.repeat(16) })
    expect(meDeletionBindings(ledger)).toEqual([])
    mergeMeDeletions(ledger, [binding])
    expect(meDeletionBindings(ledger)).toEqual([binding])
  })
  it('chunks the complete union under the existing payload budget without dropping a binding', () => {
    const records = Array.from({ length: 1_000 }, (_, i) => ({ ...binding, hash: i.toString(16).padStart(64, '0') }))
    const frames = meDeletionChunks(records)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.every((frame) => frame.byteLength <= ME_SYNC_MAX_BYTES)).toBe(true)
    expect(frames.flatMap(parseMeDeletions)).toEqual(records)
    expect(() => meDeletionChunks([binding], 1)).toThrow('too small')
    expect(meDeletionChunks([])).toEqual([])
  })
})

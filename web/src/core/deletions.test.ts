import { describe, expect, it } from 'vitest'
import { addCandidate, confirms, DELETE_WINDOW_MS, emptyDeletions, mergeDeletions, newRequestTime, promoteCandidates, suppresses, timely, validBinding } from './deletions'
const me = '11'.repeat(16), peer = '22'.repeat(16), conversation = '33'.repeat(16), target = '44'.repeat(16), hash = 'aa'.repeat(32)
const original = { id: target, from: peer, sentAt: 100, contentHash: hash }
const binding = { conversation, target, hash, author: peer, requestAt: 200 }
describe('authenticated deletion rules', () => {
  it('uses the exact inclusive hour, safe integers, and nonnegative differences', () => {
    expect(timely(100, 100)).toBe(true)
    expect(timely(100, 100 + DELETE_WINDOW_MS)).toBe(true)
    for (const at of [99, 101 + DELETE_WINDOW_MS, NaN, Infinity, 200.5, Number.MAX_SAFE_INTEGER + 1]) expect(timely(100, at)).toBe(false)
    for (const at of [0, -1, NaN, 0.5]) expect(timely(at, 100)).toBe(false)
  })
  it('allows only the explicit 2-second original skew', () => {
    expect(newRequestTime(2_100, 100)).toBe(2_100)
    expect(newRequestTime(2_101, 100)).toBeUndefined()
    expect(newRequestTime(100, 100 + DELETE_WINDOW_MS)).toBe(100 + DELETE_WINDOW_MS)
    expect(newRequestTime(100, 101 + DELETE_WINDOW_MS)).toBeUndefined()
  })
  it('validates widths and never uses routing IDs as authentication', () => {
    expect(validBinding(binding)).toBe(true)
    for (const change of [{ target: 'a' }, { hash: 'aa' }, { author: '' }, { requestAt: -1 }]) expect(validBinding({ ...binding, ...change })).toBe(false)
    expect(confirms({ ...binding, target: '99'.repeat(16) }, original, me)).toBe(true)
    expect(confirms(binding, { ...original, contentHash: 'bb'.repeat(32) }, me)).toBe(false)
    expect(confirms(binding, { ...original, from: me }, me)).toBe(false)
    expect(confirms(binding, { ...original, kind: 'notice' }, me)).toBe(false)
  })
  it('keeps unknown candidates unverified and does not let an invalid one poison a valid one', () => {
    const ledger = emptyDeletions()
    addCandidate(ledger, { ...binding, requestAt: 99 })
    addCandidate(ledger, binding)
    expect(promoteCandidates(ledger, conversation, [], me)).toBe(false)
    expect(ledger.records).toHaveLength(0)
    expect(promoteCandidates(ledger, conversation, [original], me)).toBe(true)
    expect(ledger.records).toHaveLength(1)
    expect(ledger.records[0]).toMatchObject({ remote: true, originalAt: 100 })
    expect(ledger.records[0].localIntent).toBeUndefined()
    expect(ledger.candidates).toHaveLength(1)
  })
  it('caps candidates without evicting verified tombstones and deduplicates semantic requests', () => {
    const ledger = emptyDeletions()
    addCandidate(ledger, binding)
    addCandidate(ledger, { ...binding, target: '99'.repeat(16) })
    expect(ledger.candidates).toHaveLength(1)
    promoteCandidates(ledger, conversation, [original], me)
    for (let i = 0; i < 300; i++) addCandidate(ledger, { ...binding, requestAt: 1_000 + i })
    expect(ledger.candidates).toHaveLength(256)
    for (let i = 0; i < 2_200; i++) addCandidate(ledger, { ...binding, conversation: String(i), requestAt: 1_000 + i })
    expect(ledger.candidates).toHaveLength(2_048)
    expect(ledger.records).toHaveLength(1)
  })
  it('enforces the serialized candidate-byte bound without touching verified records', () => {
    const ledger = emptyDeletions()
    ledger.records.push({ scope: 'everyone', ...binding, remote: true })
    addCandidate(ledger, { ...binding, conversation: 'x'.repeat(4 * 1024 * 1024) })
    expect(ledger.candidates).toHaveLength(0)
    expect(ledger.records).toHaveLength(1)
  })
  it('suppresses every authentic copy but only the local identifier for legacy Me', () => {
    const verified = { scope: 'everyone' as const, ...binding }
    expect(suppresses(verified, { ...original, id: '99'.repeat(16) }, conversation, me)).toBe(true)
    expect(suppresses(verified, { ...original, contentHash: 'bb'.repeat(32) }, conversation, me)).toBe(false)
    const legacy = { scope: 'me' as const, conversation, target }
    expect(suppresses(legacy, { ...original, contentHash: undefined }, conversation, me)).toBe(true)
    expect(suppresses(legacy, { ...original, id: '99'.repeat(16) }, conversation, me)).toBe(false)
    expect(suppresses(legacy, original, 'other', me)).toBe(false)
  })
  it('merges irreversible records by union without inventing own retry authority', () => {
    const local = emptyDeletions(), remote = emptyDeletions()
    local.records.push({ scope: 'everyone', ...binding, eventId: target, originalAt: 100, localIntent: true, status: 'failed' })
    remote.records.push({ scope: 'everyone', ...binding, remote: true })
    const merged = mergeDeletions(local, remote)
    expect(mergeDeletions(merged, local).records).toHaveLength(2)
    expect(mergeDeletions(emptyDeletions(), remote).records[0].localIntent).toBeUndefined()
  })
})

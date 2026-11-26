import { describe, expect, it } from 'vitest'
import { applyGroupTopic, applyGroupTopicSnapshot, MAX_GROUP_TOPIC_BYTES, nextGroupTopicClock } from './groupTopic'

const alice = { account: 'alice', device: 'a' }
const bob = { account: 'bob', device: 'b' }

describe('group topic state rules', () => {
  it('validates UTF-8 bytes, clock, and clears with an empty topic', () => {
    const old = applyGroupTopic(undefined, { text: 'old', clock: 1 }, alice)!
    expect(applyGroupTopic(old, { text: 'é'.repeat(MAX_GROUP_TOPIC_BYTES / 2 + 1), clock: 2 }, alice)).toBe(old)
    expect(applyGroupTopic(old, { text: 'x', clock: Number.MAX_SAFE_INTEGER + 1 }, alice)).toBe(old)
    expect(applyGroupTopic(old, { text: '', clock: 2 }, alice)?.text).toBe('')
  })

  it('converges for concurrent updates and ignores body identity', () => {
    const a = { text: 'first', clock: 2, account: 'z' }
    const b = { text: 'second', clock: 2, account: 'a' }
    const ab = applyGroupTopic(applyGroupTopic(undefined, a, alice), b, bob)
    const ba = applyGroupTopic(applyGroupTopic(undefined, b, bob), a, alice)
    expect(ab).toEqual(ba)
    expect(ab).toEqual({ text: 'second', clock: 2, ...bob })
  })

  it('merges attested snapshots without rolling back updates or clears', () => {
    const cleared = applyGroupTopic(undefined, { text: '', clock: 4 }, alice)!
    const snapshot = { text: 'prior', clock: 3, ...bob }
    expect(applyGroupTopicSnapshot(cleared, snapshot)).toBe(cleared)
    expect(applyGroupTopicSnapshot(undefined, cleared)).toEqual(cleared)
    expect(applyGroupTopicSnapshot(snapshot, cleared)).toEqual(cleared)
    expect(applyGroupTopicSnapshot(cleared, { ...snapshot, clock: 4, text: 'new' })).toEqual({ ...snapshot, clock: 4, text: 'new' })
  })

  it('rejects malformed snapshots and preserves unknown state', () => {
    for (const snapshot of [null, [], {}, { text: 'x', clock: 1, account: '', device: 'd' },
      { text: 'x', clock: 1, account: 'a', device: 1 },
      { text: 'x', clock: 0, account: 'a', device: 'd' },
      { text: 'é'.repeat(257), clock: 1, account: 'a', device: 'd' }]) {
      expect(applyGroupTopicSnapshot(undefined, snapshot)).toBeUndefined()
    }
  })

  it('advances the clock without exceeding the safe integer range', () => {
    expect(nextGroupTopicClock(undefined)).toBe(1)
    expect(nextGroupTopicClock({ text: '', clock: 2, ...alice })).toBe(3)
    expect(nextGroupTopicClock({ text: '', clock: Number.MAX_SAFE_INTEGER, ...alice })).toBeUndefined()
    expect(nextGroupTopicClock({ text: '', clock: NaN, ...alice })).toBeUndefined()
  })

  it('does not let old messages or duplicates replace newer state', () => {
    const current = applyGroupTopic(undefined, { text: 'new', clock: 3 }, alice)!
    expect(applyGroupTopic(current, { text: 'old', clock: 2 }, bob)).toBe(current)
    expect(applyGroupTopic(current, { text: 'new', clock: 3 }, alice)).toBe(current)
  })
})

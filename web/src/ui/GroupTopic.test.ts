import { describe, expect, it } from 'vitest'
import { GROUP_TOPIC_MAX_BYTES, topicBytes } from './GroupTopic'

describe('group topic byte limit', () => {
  it('counts UTF-8 bytes rather than UTF-16 characters', () => {
    expect(topicBytes('a'.repeat(512))).toBe(GROUP_TOPIC_MAX_BYTES)
    expect(topicBytes('é'.repeat(256))).toBe(GROUP_TOPIC_MAX_BYTES)
    expect(topicBytes('😀'.repeat(128))).toBe(GROUP_TOPIC_MAX_BYTES)
    expect(topicBytes('😀'.repeat(129))).toBeGreaterThan(GROUP_TOPIC_MAX_BYTES)
    expect(topicBytes('')).toBe(0)
  })
})

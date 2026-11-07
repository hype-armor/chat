import { describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import * as replies from './replies'

describe('conversation reply lookup', () => {
  it('reports missing verification before reply composition without exposing hashes', async () => {
    const engine = new Engine(() => {})
    const hash = '22'.repeat(32)
    const base = { from: 'me', text: 'Original', sentAt: 1, status: 'sent' as const }
    const history: Awaited<ReturnType<Engine['stored']>> = [
      { ...base, id: '11'.repeat(16), contentHash: hash, canReply: false },
      { ...base, id: '33'.repeat(16), canReply: true }, // An imported hint cannot override worker policy.
      { ...base, id: '44'.repeat(16), contentHash: 'invalid' },
      { ...base, id: 'invalid', contentHash: hash },
      { ...base, id: '55'.repeat(16), kind: 'notice', contentHash: hash },
      { ...base, id: '66'.repeat(16), status: 'sending' },
    ]
    engine['state'].outbox.push({ messageId: '66'.repeat(16), conversationId: 'conversation-a', envelope: '', recipients: [] })
    engine['stored'] = vi.fn(async () => history)
    const messages = await engine.messages('conversation-a')
    expect(messages.map((message) => message.canReply)).toEqual([true, false, false, false, false, false])
    for (const message of messages) {
      expect(message).not.toHaveProperty('contentHash')
      expect(message).not.toHaveProperty('replyToHash')
    }
    expect(history[1].contentHash).toBeUndefined()
    // A pending message becomes eligible after encryption supplies its original hash.
    history[5].contentHash = hash
    expect((await engine.messages('conversation-a'))[5].canReply).toBe(true)
  })

  it('uses the first non-notice original when duplicate identifiers differ', async () => {
    const engine = new Engine(() => {})
    const hash = '22'.repeat(32)
    const otherHash = '33'.repeat(32)
    const base = { from: 'me', text: 'Original', sentAt: 1, status: 'sent' as const }
    engine['stored'] = vi.fn(async () => [
      { ...base, id: '11'.repeat(16) },
      { ...base, id: '11'.repeat(16), contentHash: hash },
      { ...base, id: '44'.repeat(16), contentHash: hash },
      { ...base, id: '44'.repeat(16), contentHash: otherHash },
      { ...base, id: '55'.repeat(16), kind: 'notice' as const, contentHash: otherHash },
      { ...base, id: '55'.repeat(16), contentHash: hash },
    ])
    expect((await engine.messages('conversation-a')).map((message) => message.canReply))
      .toEqual([false, false, true, false, false, true])
  })

  it('builds one local lookup per history load and shares it across previews', async () => {
    const engine = new Engine(() => {})
    const hash = '22'.repeat(32)
    const originalId = '11'.repeat(16)
    const history: Awaited<ReturnType<Engine['stored']>> = [
      { id: originalId, from: 'me', text: 'Original', sentAt: 1, status: 'sent', contentHash: hash },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: (index + 2).toString(16).padStart(32, '0'), from: 'me', text: 'Reply', sentAt: 2,
        status: 'sent' as const, replyTo: originalId, replyToHash: hash,
      })),
    ]
    engine['stored'] = vi.fn(async () => history)
    const build = vi.spyOn(replies, 'buildReplyLookup')
    const preview = vi.spyOn(replies, 'replyPreview')
    try {
      const messages = await engine.messages('conversation-a')
      expect(engine['stored']).toHaveBeenCalledWith('conversation-a')
      expect(build).toHaveBeenCalledExactlyOnceWith(history)
      expect(preview).toHaveBeenCalledTimes(100)
      const lookup = build.mock.results[0].value
      expect(preview.mock.calls.every((call) => call[1] === lookup)).toBe(true)
      expect(messages.slice(1).every((message) => message.reply?.text === 'Original')).toBe(true)

      // A different load cannot reuse originals from the previous conversation.
      engine['stored'] = vi.fn(async () => history.slice(1))
      const missing = await engine.messages('conversation-b')
      expect(build).toHaveBeenCalledTimes(2)
      expect(build.mock.results[1].value).not.toBe(lookup)
      expect(missing.every((message) => message.reply?.unavailable === true)).toBe(true)
    } finally {
      build.mockRestore()
      preview.mockRestore()
    }
  })
})

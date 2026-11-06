import { describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import * as replies from './replies'

describe('conversation reply lookup', () => {
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

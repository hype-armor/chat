import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../core/protocol'
import { quoteMessage } from './messageInteractions'
import { nearMessageBottom } from './useMessageScroll'

const base: ChatMessage = { id: 'envelope-id', from: 'me', text: 'Hello', sentAt: 1, status: 'sent' }

describe('quoteMessage', () => {
  it('keeps the original envelope ID and an accessible sender label', () => {
    expect(quoteMessage(base)).toEqual({ messageId: 'envelope-id', from: 'me', fromName: 'You', text: 'Hello' })
  })
  it('bounds the selectable preview without changing the original', () => {
    const message = { ...base, text: 'x'.repeat(1000) }
    expect(quoteMessage(message).text).toHaveLength(280)
    expect(message.text).toHaveLength(1000)
  })
  it('provides labels for non-text messages', () => {
    expect(quoteMessage({ ...base, text: '' }).text).toBe('Message')
    expect(quoteMessage({ ...base, text: '', location: { latitude: 0, longitude: 0, accuracyM: 1 } }).text).toBe('Location')
  })
})

describe('nearMessageBottom', () => {
  it('uses an inclusive 80px follow threshold', () => {
    expect(nearMessageBottom(1000, 520, 400)).toBe(true)
    expect(nearMessageBottom(1000, 519, 400)).toBe(false)
    expect(nearMessageBottom(200, 0, 400)).toBe(true)
  })
})

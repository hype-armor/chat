import { describe, expect, it } from 'vitest'
import { toHex } from './ids'
import type { ChatMessage } from './protocol'
import { applyReceipt, splitIds, statusAfterReceipts } from './receipts'

const mine = (status: ChatMessage['status'] = 'sent'): ChatMessage => ({
  id: 'm',
  from: 'me',
  text: 'hi',
  sentAt: 0,
  status,
})

describe('receipts', () => {
  it('1:1: delivered, then read', () => {
    const m = mine()
    applyReceipt(m, 'bob', false, ['bob'])
    expect(m.status).toBe('delivered')
    applyReceipt(m, 'bob', true, ['bob'])
    expect(m.status).toBe('read')
  })
  it('groups: only when every other member has it', () => {
    const m = mine()
    applyReceipt(m, 'bob', true, ['bob', 'cat'])
    expect(m.status).toBe('sent')
    applyReceipt(m, 'cat', false, ['bob', 'cat'])
    expect(m.status).toBe('delivered')
    applyReceipt(m, 'cat', true, ['bob', 'cat'])
    expect(m.status).toBe('read')
  })
  it('never upgrades unsent messages', () => {
    expect(statusAfterReceipts({ ...mine('sending'), readBy: ['bob'] }, ['bob'])).toBe('sending')
  })
  it('splits ids', () => {
    const flat = new Uint8Array(32).fill(1, 16)
    expect(splitIds(flat, toHex)).toEqual(['00'.repeat(16), '01'.repeat(16)])
  })
})

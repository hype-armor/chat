import { describe, expect, it } from 'vitest'
import { MAX_QUOTE_LENGTH, replyPreview, validReplyId } from './replies'

const id = '11'.repeat(16)
const hash = '22'.repeat(32)
const target = { id, from: 'authenticated-account', text: 'A message', contentHash: hash }

describe('worker quote previews', () => {
  it('resolves authors from verified same-conversation history, not the replying sender', () => {
    expect(replyPreview(id, [target], (account) => `Name: ${account}`, hash)).toEqual({
      messageId: id, from: 'authenticated-account', fromName: 'Name: authenticated-account', text: 'A message',
    })
    expect(replyPreview(id, [], () => 'Attacker', hash)).toEqual({ messageId: id, text: 'Message unavailable', unavailable: true })
  })
  it('rejects ID substitution, mismatched hashes, and legacy references without hashes', () => {
    expect(replyPreview(id, [{ ...target, contentHash: '33'.repeat(32) }], () => 'Attacker', hash).unavailable).toBe(true)
    expect(replyPreview(id, [{ ...target, contentHash: undefined }], () => 'Legacy', hash).unavailable).toBe(true)
    expect(replyPreview(id, [target], () => 'Legacy').unavailable).toBe(true)
    expect(replyPreview(id, [target], () => 'Invalid', 'short').unavailable).toBe(true)
  })
  it('bounds previews, strips controls, and excludes notices', () => {
    expect(replyPreview(id, [{ ...target, text: '\n' + 'x'.repeat(4000) }], () => 'Alex', hash).text).toBe(' ' + 'x'.repeat(MAX_QUOTE_LENGTH - 1))
    expect(replyPreview(id, [{ ...target, kind: 'notice' }], () => 'Alex', hash).unavailable).toBe(true)
    expect(validReplyId('constructor')).toBe(false)
    expect(validReplyId('AB'.repeat(16))).toBe(false)
  })
  it('does not expose file keys or location coordinates in a quote', () => {
    const location = { latitude: 1, longitude: 2, accuracyM: 3 }
    expect(replyPreview(id, [{ ...target, text: '', location }], () => 'Alex', hash).text).toBe('Location')
    expect(replyPreview(id, [{ ...target, text: '', file: { name: 'secret', mime: 'image/jpeg', size: 10 } }], () => 'Alex', hash).text).toBe('Attachment')
  })
})

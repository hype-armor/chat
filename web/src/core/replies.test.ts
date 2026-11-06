import { describe, expect, it, vi } from 'vitest'
import { buildReplyLookup, MAX_QUOTE_LENGTH, replyPreview, validReplyId } from './replies'

const id = '11'.repeat(16)
const hash = '22'.repeat(32)
const target = { id, from: 'authenticated-account', text: 'A message', contentHash: hash }

describe('worker quote previews', () => {
  it('resolves authors from verified same-conversation history, not the replying sender', () => {
    const lookup = buildReplyLookup([target])
    expect(replyPreview(id, lookup, (account) => `Name: ${account}`, hash)).toEqual({
      messageId: id, from: 'authenticated-account', fromName: 'Name: authenticated-account', text: 'A message',
    })
    expect(replyPreview(id, buildReplyLookup([]), () => 'Attacker', hash)).toEqual({ messageId: id, text: 'Message unavailable', unavailable: true })
    expect(replyPreview('44'.repeat(16), lookup, () => 'Attacker', hash).unavailable).toBe(true)
  })

  it('rejects ID substitution, mismatched hashes, and legacy references without hashes', () => {
    expect(replyPreview(id, buildReplyLookup([{ ...target, contentHash: '33'.repeat(32) }]), () => 'Attacker', hash).unavailable).toBe(true)
    expect(replyPreview(id, buildReplyLookup([{ ...target, contentHash: undefined }]), () => 'Legacy', hash).unavailable).toBe(true)
    expect(replyPreview(id, buildReplyLookup([target]), () => 'Legacy').unavailable).toBe(true)
    expect(replyPreview(id, buildReplyLookup([target]), () => 'Invalid', 'short').unavailable).toBe(true)
    const invalidId = 'AB'.repeat(16)
    expect(replyPreview(invalidId, buildReplyLookup([{ ...target, id: invalidId }]), () => 'Invalid', hash).unavailable).toBe(true)
  })

  it('preserves the first non-notice duplicate even when a later duplicate has the requested hash', () => {
    const first = { ...target, from: 'first-author', text: 'First original' }
    const secondHash = '33'.repeat(32)
    const second = { ...target, from: 'second-author', text: 'Second original', contentHash: secondHash }
    const lookup = buildReplyLookup([{ ...target, kind: 'notice' }, first, second])
    expect(lookup.get(id)).toBe(first)
    expect(replyPreview(id, lookup, (account) => account, hash)).toMatchObject({ from: 'first-author', text: 'First original' })
    expect(replyPreview(id, lookup, (account) => account, secondHash)).toEqual({ messageId: id, text: 'Message unavailable', unavailable: true })
    const legacyFirst = buildReplyLookup([{ ...first, contentHash: undefined }, second])
    expect(replyPreview(id, legacyFirst, (account) => account, secondHash).unavailable).toBe(true)
  })

  it('prepares history in one pass and reuses the lookup for every preview', () => {
    const count = 1000
    let passes = 0
    let visits = 0
    const history = {
      *[Symbol.iterator]() {
        passes++
        for (let index = 0; index < count; index++) {
          visits++
          yield { ...target, id: index.toString(16).padStart(32, '0') }
        }
      },
    }
    const lookup = buildReplyLookup(history)
    expect(passes).toBe(1)
    expect(visits).toBe(count)
    expect(lookup.size).toBe(count)
    const get = vi.spyOn(lookup, 'get')
    for (let index = 0; index < count; index++) {
      const messageId = index.toString(16).padStart(32, '0')
      expect(replyPreview(messageId, lookup, (account) => account, hash).text).toBe(target.text)
    }
    expect(get).toHaveBeenCalledTimes(count)
    expect(passes).toBe(1)
    expect(visits).toBe(count)
  })

  it('bounds previews, strips controls, and excludes notices', () => {
    expect(replyPreview(id, buildReplyLookup([{ ...target, text: '\n' + 'x'.repeat(4000) }]), () => 'Alex', hash).text).toBe(' ' + 'x'.repeat(MAX_QUOTE_LENGTH - 1))
    expect(replyPreview(id, buildReplyLookup([{ ...target, kind: 'notice' }]), () => 'Alex', hash).unavailable).toBe(true)
    expect(validReplyId('constructor')).toBe(false)
    expect(validReplyId('AB'.repeat(16))).toBe(false)
  })

  it('does not expose file keys or location coordinates in a quote', () => {
    const location = { latitude: 1, longitude: 2, accuracyM: 3 }
    expect(replyPreview(id, buildReplyLookup([{ ...target, text: '', location }]), () => 'Alex', hash).text).toBe('Location')
    expect(replyPreview(id, buildReplyLookup([{ ...target, text: '', file: { name: 'secret', mime: 'image/jpeg', size: 10 } }]), () => 'Alex', hash).text).toBe('Attachment')
  })
})

import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../core/protocol'
import { canDeleteEveryone, deletedPlaceholder, deletionWarnings, projectAcceptedDeletions } from './deletion'

const own: ChatMessage = { id: 'original', from: 'me', text: 'Private', status: 'sent', sentAt: 1, canDeleteForEveryone: true, deleteForEveryoneUntil: 3_600_001 }

describe('deletion capabilities and confirmation', () => {
  for (const scope of ['me', 'everyone'] as const) {
    it(`scrubs every accepted ${scope} reference from immediate and repeated stale snapshots`, () => {
      const reply = { ...own, id: 'reply', text: 'Keep reply body', replyTo: own.id, reply: { messageId: own.id, text: 'Private preview' } }
      const previewOnly = { ...reply, id: 'preview-only', replyTo: undefined }
      const referenceOnly = { ...reply, id: 'reference-only', reply: undefined }
      const unrelated = { ...reply, id: 'unrelated', replyTo: 'other', reply: { messageId: 'other', text: 'Keep unrelated preview' } }
      const stale = [own, reply, previewOnly, referenceOnly, unrelated]
      // Negative control: no accepted intent must preserve readable previews.
      expect(projectAcceptedDeletions(stale, new Map())[1].reply?.text).toBe('Private preview')
      const accepted = new Map([[own.id, scope]])
      for (let retry = 0; retry < 3; retry++) {
        const projected = projectAcceptedDeletions(stale, accepted)
        for (const id of ['reply', 'preview-only', 'reference-only']) {
          expect(projected.find((message) => message.id === id)).toMatchObject({ text: 'Keep reply body', reply: { messageId: own.id, text: 'Original message unavailable', unavailable: true } })
        }
        expect(projected.find((message) => message.id === 'unrelated')).toBe(unrelated)
        expect(projected.some((message) => message.id === own.id)).toBe(scope === 'everyone')
      }
      expect(reply.reply.text).toBe('Private preview') // Projection must not mutate the captured snapshot.
    })
  }

  it('uses the inclusive worker deadline and fails closed for absent legacy evidence', () => {
    expect(canDeleteEveryone(own, 3_600_001)).toBe(true)
    expect(canDeleteEveryone(own, 3_600_002)).toBe(false)
    expect(canDeleteEveryone({ ...own, canDeleteForEveryone: undefined }, 2)).toBe(false)
    expect(canDeleteEveryone({ ...own, deleteForEveryoneUntil: undefined }, 2)).toBe(false)
    expect(canDeleteEveryone({ ...own, deleted: true }, 2)).toBe(false)
    expect(canDeleteEveryone({ ...own, deleteForEveryoneUntil: NaN }, 2)).toBe(false)
  })
  it('drops original content, reactions, previews, location, and media from a local accepted placeholder', () => {
    const placeholder = deletedPlaceholder({ ...own, file: { name: 'secret', mime: 'text/plain', size: 10 }, location: { latitude: 1, longitude: 2, accuracyM: 3 }, reply: { messageId: 'quote', text: 'secret quote' }, reactions: [{ emoji: '👍', count: 1, own: true }] })
    expect(placeholder).toMatchObject({ deleted: true, text: '', canReply: false, canReact: false, canDeleteForEveryone: false })
    for (const field of ['file', 'location', 'live', 'reply', 'replyTo', 'reactions', 'reactionStatus']) expect(placeholder).not.toHaveProperty(field)
  })
  it('uses independent worker authorization, never the UI author marker or reply capability', () => {
    expect(canDeleteEveryone({ ...own, canDeleteForEveryone: false }, 2)).toBe(false)
    expect(canDeleteEveryone({ ...own, canReply: false }, 2)).toBe(true)
  })
  it('explains unlimited local fallback, pending delivery, hidden retry, and live producer effects', () => {
    const warnings = deletionWarnings({ ...own, status: 'sending', deletionStatus: { id: 'intent', status: 'failed' }, live: { sessionId: 'session', expiresAt: 10, ended: false } }, 'me').join(' ')
    expect(warnings).toContain('only from this device')
    expect(warnings).toContain('still be delivered')
    expect(warnings).toContain('hides the deletion status and retry control')
    expect(warnings).toContain('stops matching live location')
  })
  it('uses all-own-devices copy only for an explicit verified worker capability', () => {
    for (const from of ['me', 'peer']) {
      const verified = { ...own, from, deleteForMeLocalOnly: false }
      const text = deletionWarnings(verified, 'me').join(' ')
      expect(text).toContain('your own linked devices when they connect')
      expect(text).toContain('Other people keep their copies')
      expect(text).not.toContain('only from this device')
      expect(text).toContain('exports, old backups, and older clients')
      expect(deletedPlaceholder(verified).deleteForMeLocalOnly).toBe(false)
    }
    for (const flag of [true, undefined]) {
      const text = deletionWarnings({ ...own, deleteForMeLocalOnly: flag }, 'me').join(' ')
      expect(text).toContain('only from this device')
      expect(text).toContain('Verification data is unavailable')
      expect(text).not.toContain('your own linked devices when they connect')
    }
  })
  it('does not promise remote erasure or stop another author producer', () => {
    expect(deletionWarnings(own, 'everyone').join(' ')).toContain('does not confirm remote erasure')
    expect(deletionWarnings({ ...own, from: 'peer' }, 'me').join(' ')).not.toContain('stops matching')
  })
})

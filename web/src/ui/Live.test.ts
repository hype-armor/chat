import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../core/protocol'
import { contactLiveLocations } from './Live'

const now = 1_000_000
function share(id: string, from = 'alice'): ChatMessage {
  return {
    id,
    from,
    text: '',
    sentAt: now - 1000,
    status: 'received',
    live: {
      sessionId: id,
      untilStopped: true,
      expiresAt: now + 60_000,
      ended: false,
      latest: { latitude: 48.8584, longitude: 2.2945, accuracyM: 12, at: now },
    },
  }
}

describe('contact live locations', () => {
  it('shows only live shares from the selected contact', () => {
    const alice = share('alice-device-1')
    const secondDevice = share('alice-device-2')
    expect(contactLiveLocations([alice, share('bob', 'bob'), share('ours', 'me'), secondDevice], 'alice', now))
      .toEqual([alice, secondDevice])
  })

  it('omits stopped, expired, missing-point and one-shot locations', () => {
    const ended = share('ended')
    ended.live!.ended = true
    const stopped = share('stopped')
    stopped.live!.stopped = true
    const expired = share('expired')
    expired.live!.expiresAt = now
    const noPoint = share('no-point')
    noPoint.live!.latest = undefined
    const once = share('one-shot')
    once.location = once.live!.latest
    once.live = undefined
    expect(contactLiveLocations([ended, stopped, expired, noPoint, once], 'alice', now)).toEqual([])
  })
})

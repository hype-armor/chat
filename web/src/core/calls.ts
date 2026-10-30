// The call log (ADR-0028): what each device remembers of a call while it
// rings and runs, and the notice it leaves in the conversation. Media and
// RTCPeerConnection live on the page; this sees only the signalling.

import type { CallKind } from './protocol'

/** How long a call rings before the caller gives up. */
export const RING_MS = 45_000
/** Offers older than this (by the sender's clock) are missed calls, not calls to ring for. */
export const STALE_OFFER_MS = 120_000
/** Unanswered calls with no word from either side end as missed. */
export const GIVE_UP_MS = 75_000

export const CALL_KINDS: CallKind[] = ['offer', 'answer', 'candidate', 'hangup', 'decline', 'busy']

export type CallRecord = {
  conversationId: string
  /** Placed by this account (on this or another of its devices). */
  outgoing: boolean
  video: boolean
  startedAt: number
  answeredAt?: number
  /** Answered or declined on another of this user's devices. */
  elsewhere?: 'answered' | 'declined'
}

export type CallEnd = 'hangup' | 'decline' | 'busy' | 'timeout'

/**
 * The notice for a call that ended; `byMe` says whether this account sent
 * the final signal. `missed` notices count as unread.
 */
export function callNotice(
  call: CallRecord,
  end: CallEnd,
  byMe: boolean,
  now: number,
): { text: string; missed: boolean } {
  const what = call.video ? 'video call' : 'voice call'
  const icon = call.video ? '🎥' : '📞'
  const cap = what[0].toUpperCase() + what.slice(1)
  if (call.answeredAt !== undefined) {
    if (call.elsewhere === 'answered') return { text: `${icon} ${cap} answered on another device`, missed: false }
    return { text: `${icon} ${cap} · ${formatCallDuration(now - call.answeredAt)}`, missed: false }
  }
  if (call.elsewhere === 'declined' || (!call.outgoing && byMe && end === 'decline'))
    return { text: `${icon} Declined ${what}`, missed: false }
  if (call.outgoing) {
    if (end === 'decline') return { text: `${icon} ${cap} declined`, missed: false }
    if (end === 'busy') return { text: `${icon} ${cap}: line busy`, missed: false }
    // The page hangs up by itself when nobody answers.
    if (byMe && end === 'hangup' && now - call.startedAt < RING_MS - 1_000)
      return { text: `${icon} Cancelled ${what}`, missed: false }
    return { text: `${icon} ${cap}: no answer`, missed: false }
  }
  return { text: `${icon} Missed ${what}`, missed: true }
}

/** `0:42`, `12:05`, `1:02:09`. */
export function formatCallDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** A size cap for SDP and candidates from other devices (they reach the page). */
export function safeSignalText(text: string, max: number): string | undefined {
  return text.length > 0 && text.length <= max ? text : undefined
}

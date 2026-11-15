import { useEffect, useState } from 'react'
import type { ChatMessage } from '../core/protocol'

/** Capabilities are worker-derived. Missing evidence never grants everyone deletion. */
export function canDeleteEveryone(message: ChatMessage, now: number): boolean {
  return message.canDeleteForEveryone === true && !message.deleted &&
    Number.isSafeInteger(message.deleteForEveryoneUntil) && now <= message.deleteForEveryoneUntil!
}

/** A local accepted result must not retain original content while history refreshes. */
export function deletedPlaceholder(message: ChatMessage): ChatMessage {
  return {
    id: message.id, from: message.from, fromName: message.fromName,
    sentAt: message.sentAt, status: message.status, text: '', deleted: true,
    canDeleteForMe: message.canDeleteForMe,
    deleteForMeLocalOnly: message.deleteForMeLocalOnly,
    canDeleteForEveryone: false, canReply: false, canReact: false,
    deletionStatus: message.deletionStatus,
  }
}

/** Apply accepted intents to every snapshot, including quotes on surviving messages. */
export function projectAcceptedDeletions(messages: ChatMessage[], accepted: ReadonlyMap<string, 'me' | 'everyone'>): ChatMessage[] {
  const unavailable = new Set(accepted.keys())
  for (const message of messages) if (message.deleted) unavailable.add(message.id)
  return messages.filter((message) => accepted.get(message.id) !== 'me').map((message) => {
    if (accepted.get(message.id) === 'everyone' || message.deleted) return deletedPlaceholder(message)
    const target = message.reply?.messageId && unavailable.has(message.reply.messageId)
      ? message.reply.messageId : message.replyTo && unavailable.has(message.replyTo) ? message.replyTo : undefined
    return target ? { ...message, reply: { messageId: target, text: 'Original message unavailable', unavailable: true } } : message
  })
}

/** Expire a displayed capability at the inclusive boundary plus 1 millisecond. */
export function useDeletionDeadline(deadline: number | undefined) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    if (deadline === undefined || !Number.isSafeInteger(deadline)) return
    const delay = deadline + 1 - Date.now()
    if (delay <= 0) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [deadline])
  return now
}

export function deletionWarnings(message: ChatMessage, scope: 'me' | 'everyone'): string[] {
  const localOnly = message.deleteForMeLocalOnly !== false
  const warnings = scope === 'me'
    ? [localOnly
      ? 'Delete only from this device. Verification data is unavailable, so other devices keep their copies.'
      : 'Delete from this device and your own linked devices when they connect. Other people keep their copies.']
    : ['Delete locally and request deletion on other devices. Local acceptance does not confirm remote erasure.']
  if (scope === 'me' && (message.status === 'sending' || message.status === 'failed')) warnings.push('This does not recall a queued message. It can still be delivered.')
  if (scope === 'me' && message.deletionStatus) warnings.push('This also hides the deletion status and retry control. The delivery record is retained.')
  if (message.live && message.from === 'me') warnings.push(scope === 'me' && !localOnly
    ? 'This stops matching live location sharing on this device and your linked devices when they receive the deletion.'
    : 'This stops matching live location sharing on this device.')
  warnings.push('Screenshots, exports, old backups, and older clients may keep this message.')
  return warnings
}

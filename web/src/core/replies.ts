import type { ChatMessage, ReplyPreview } from './protocol'
import { toHex } from './ids'

export const MAX_QUOTE_LENGTH = 160
export const validReplyId = (id: string): boolean => /^[0-9a-f]{32}$/.test(id)
export const validContentHash = (hash: string | undefined): hash is string => !!hash && /^[0-9a-f]{64}$/.test(hash)
export const hashHex = (bytes: Uint8Array | undefined): string | undefined => bytes?.length === 32 ? toHex(bytes) : undefined

type ReplyOriginal = Pick<ChatMessage, 'id' | 'from' | 'kind' | 'text' | 'location' | 'live'> & {
  file?: unknown
  contentHash?: string
}

/** Build once from exactly one conversation. Preserve the first non-notice match. */
export function buildReplyLookup(history: Iterable<ReplyOriginal>): ReadonlyMap<string, ReplyOriginal> {
  const lookup = new Map<string, ReplyOriginal>()
  for (const message of history) {
    if (message.kind !== 'notice' && !lookup.has(message.id)) lookup.set(message.id, message)
  }
  return lookup
}

/** Reuse the conversation-local lookup; never accept a remote preview. */
export function replyPreview(
  messageId: string,
  lookup: ReadonlyMap<string, ReplyOriginal>,
  nameOf: (account: string) => string,
  replyToHash?: string,
): ReplyPreview {
  const target = lookup.get(messageId)
  if (!validReplyId(messageId) || !target || !validContentHash(replyToHash) || target.contentHash !== replyToHash) {
    return { messageId, text: 'Message unavailable', unavailable: true }
  }
  const text = target.text || (target.file ? 'Attachment' : target.live ? 'Live location' : target.location ? 'Location' : 'Message')
  return {
    messageId,
    from: target.from,
    fromName: nameOf(target.from).slice(0, 64),
    text: text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_QUOTE_LENGTH),
  }
}

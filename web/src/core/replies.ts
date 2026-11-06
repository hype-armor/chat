import type { ChatMessage, ReplyPreview } from './protocol'
import { toHex } from './ids'

export const MAX_QUOTE_LENGTH = 160
export const validReplyId = (id: string): boolean => /^[0-9a-f]{32}$/.test(id)
export const validContentHash = (hash: string | undefined): hash is string => !!hash && /^[0-9a-f]{64}$/.test(hash)
export const hashHex = (bytes: Uint8Array | undefined): string | undefined => bytes?.length === 32 ? toHex(bytes) : undefined

/** The caller supplies history from exactly one conversation, never a remote preview. */
export function replyPreview(
  messageId: string,
  history: (Pick<ChatMessage, 'id' | 'from' | 'kind' | 'text' | 'location' | 'live'> & { file?: unknown; contentHash?: string })[],
  nameOf: (account: string) => string,
  replyToHash?: string,
): ReplyPreview {
  const target = history.find((m) => m.id === messageId && m.kind !== 'notice')
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

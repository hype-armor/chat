// Delivery states (FR-MSG-5). Pure functions, shared by the engine and tests.

import type { ChatMessage } from './protocol'

type Receipted = Pick<ChatMessage, 'status' | 'readBy' | 'deliveredTo'>

/**
 * The status of one of our messages after receipts: read once every other
 * member has read it, delivered once every other member has it.
 */
export function statusAfterReceipts(m: Receipted, peers: string[]): ChatMessage['status'] {
  if (m.status === 'sending' || m.status === 'failed' || peers.length === 0) return m.status
  const read = m.readBy ?? []
  const delivered = [...(m.deliveredTo ?? []), ...read]
  if (peers.every((p) => read.includes(p))) return 'read'
  if (peers.every((p) => delivered.includes(p))) return 'delivered'
  return 'sent'
}

/** Records a receipt from `account` on one of our messages. */
export function applyReceipt(m: Receipted, account: string, read: boolean, peers: string[]) {
  const field = read ? 'readBy' : 'deliveredTo'
  if (!(m[field] ?? []).includes(account)) m[field] = [...(m[field] ?? []), account]
  m.status = statusAfterReceipts(m, peers)
}

/** Splits concatenated 16-byte message ids. */
export function splitIds(flat: Uint8Array, toHex: (b: Uint8Array) => string): string[] {
  const ids: string[] = []
  for (let i = 0; i + 16 <= flat.length; i += 16) ids.push(toHex(flat.slice(i, i + 16)))
  return ids
}

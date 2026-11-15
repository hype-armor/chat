import { validContentHash, validReplyId } from './replies'
import type { DeletionLedger } from './deletions'

/** Authority comes only from the authenticated private own-device MLS context. */
export type MeDeletionBinding = { conversation: string; hash: string; author: string }
export const ME_SYNC_MAX_BYTES = 48 * 1024
const encoder = new TextEncoder()
export function validMeBinding(value: unknown): value is MeDeletionBinding {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.conversation === 'string' && validReplyId(v.conversation) && typeof v.hash === 'string' && validContentHash(v.hash) && typeof v.author === 'string' && validReplyId(v.author)
}
export function meBindingKey(b: MeDeletionBinding): string { return b.conversation + ':' + b.hash + ':' + b.author }
export function meDeletionBindings(ledger: DeletionLedger): MeDeletionBinding[] {
  const found = new Map<string, MeDeletionBinding>()
  for (const record of ledger.records) {
    const b = { conversation: record.conversation, hash: record.hash, author: record.author }
    if (record.scope === 'me' && validMeBinding(b)) found.set(meBindingKey(b), b)
  }
  return [...found.values()]
}
export function markMeSyncDirty(ledger: DeletionLedger): void {
  ledger.meSyncRevision = (ledger.meSyncRevision ?? 0) + 1
}
/** Import no target, time, scope, verification flag, delivery state, or local intent. */
export function parseMeDeletions(bytes: Uint8Array): MeDeletionBinding[] {
  if (bytes.byteLength > 64 * 1024) return []
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { meDeletions?: unknown }
    if (!value || !Array.isArray(value.meDeletions)) return []
    const found = new Map<string, MeDeletionBinding>()
    for (const item of value.meDeletions) if (validMeBinding(item)) {
      const binding = { conversation: item.conversation, hash: item.hash, author: item.author }
      found.set(meBindingKey(binding), binding)
    }
    return [...found.values()]
  } catch { return [] }
}
export function mergeMeDeletions(ledger: DeletionLedger, bindings: MeDeletionBinding[]): MeDeletionBinding[] {
  const known = new Set(meDeletionBindings(ledger).map(meBindingKey))
  const novel: MeDeletionBinding[] = []
  for (const binding of bindings) if (validMeBinding(binding) && !known.has(meBindingKey(binding))) {
    known.add(meBindingKey(binding))
    ledger.records.push({ scope: 'me', ...binding, target: '', aliases: [] })
    novel.push(binding)
  }
  if (novel.length) markMeSyncDirty(ledger)
  return novel
}
/** Each complete JSON frame stays below the existing avatar-sync envelope budget. */
export function meDeletionChunks(bindings: MeDeletionBinding[], maxBytes = ME_SYNC_MAX_BYTES): Uint8Array[] {
  const frames: Uint8Array[] = []
  let chunk: MeDeletionBinding[] = []
  const encode = (items: MeDeletionBinding[]) => encoder.encode(JSON.stringify({ names: {}, usernames: {}, conversations: {}, meDeletions: items }))
  for (const binding of bindings) {
    if (!validMeBinding(binding)) continue
    if (encode([...chunk, binding]).byteLength > maxBytes && chunk.length) { frames.push(encode(chunk)); chunk = [] }
    if (encode([binding]).byteLength > maxBytes) throw new Error('Me deletion sync frame limit is too small')
    chunk.push(binding)
  }
  if (chunk.length) frames.push(encode(chunk))
  return frames
}

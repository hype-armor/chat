import { validContentHash, validReplyId } from './replies'

export const DELETE_WINDOW_MS = 3_600_000
export type DeletionBinding = { conversation: string; target: string; hash: string; author: string; requestAt: number }
export type DeletionRecord = {
  scope: 'me' | 'everyone'; conversation: string; target: string; routingTarget?: string
  hash?: string; author?: string; aliases?: string[]; originalAt?: number; requestAt?: number; liveSession?: string; fileParts?: number
  eventId?: string; localIntent?: boolean; acknowledged?: boolean; status?: 'sending' | 'failed'; error?: string; remote?: boolean
}
export type DeletionLedger = { meSyncRevision?: number; meSyncAcknowledged?: number; records: DeletionRecord[]; candidates: DeletionBinding[] }
export type DeletionOriginal = { id: string; from: string; contentHash?: string; sentAt: number; kind?: 'notice'; deleted?: boolean; live?: { sessionId: string } }
export const emptyDeletions = (): DeletionLedger => ({ records: [], candidates: [] })
export const safeTime = (n: number) => Number.isSafeInteger(n) && n > 0
export function validBinding(b: DeletionBinding): boolean {
  return !!b.conversation && validReplyId(b.target) && validContentHash(b.hash) && validReplyId(b.author) && safeTime(b.requestAt)
}
export function timely(originalAt: number, requestAt: number): boolean {
  return safeTime(originalAt) && safeTime(requestAt) && requestAt >= originalAt && requestAt - originalAt <= DELETE_WINDOW_MS
}
export function newRequestTime(originalAt: number, now: number): number | undefined {
  const at = Math.max(Math.ceil(now), originalAt)
  return originalAt <= now + 2_000 && timely(originalAt, at) ? at : undefined
}
export function confirms(b: DeletionBinding, m: DeletionOriginal, me: string): boolean {
  return m.kind !== 'notice' && b.hash === m.contentHash && b.author === (m.from === 'me' ? me : m.from) && timely(m.sentAt, b.requestAt)
}
export function suppresses(t: DeletionRecord, m: DeletionOriginal, conversation: string, me: string): boolean {
  if (t.conversation !== conversation || m.kind === 'notice') return false
  return t.hash && t.author
    ? t.hash === m.contentHash && t.author === (m.from === 'me' ? me : m.from)
    : t.scope === 'me' && t.target === m.id
}
export function equivalent(a: DeletionRecord, b: DeletionRecord): boolean {
  return a.conversation === b.conversation && a.scope === b.scope && (a.hash && b.hash
    ? a.hash === b.hash && a.author === b.author
    : !a.hash && !b.hash && a.target === b.target)
}
export function mergeDeletions(a: DeletionLedger, b: DeletionLedger): DeletionLedger {
  const records = [...a.records]
  for (const record of b.records) {
    // Keep independent own delivery intents and remote confirmation evidence.
    if (!records.some((r) => equivalent(r, record) && r.eventId === record.eventId && r.remote === record.remote)) records.push(record)
  }
  const result = { records, candidates: [...a.candidates] }
  for (const candidate of b.candidates) addCandidate(result, candidate)
  return result
}
export function addCandidate(ledger: DeletionLedger, b: DeletionBinding): void {
  if (!validBinding(b) || ledger.candidates.some((c) => c.conversation === b.conversation && c.hash === b.hash && c.author === b.author && c.requestAt === b.requestAt)) return
  ledger.candidates.push(b)
  while (ledger.candidates.filter((c) => c.conversation === b.conversation).length > 256) {
    ledger.candidates.splice(ledger.candidates.findIndex((c) => c.conversation === b.conversation), 1)
  }
  while (ledger.candidates.length > 2048 || new TextEncoder().encode(JSON.stringify(ledger.candidates)).byteLength > 4 * 1024 * 1024) ledger.candidates.shift()
}
export function promoteCandidates(ledger: DeletionLedger, conversation: string, originals: DeletionOriginal[], me: string): boolean {
  let changed = false
  ledger.candidates = ledger.candidates.filter((candidate) => {
    if (candidate.conversation !== conversation) return true
    const original = originals.find((m) => confirms(candidate, m, me))
    if (!original) return true
    const record: DeletionRecord = { scope: 'everyone', ...candidate, routingTarget: candidate.target, target: original.id, aliases: originals.filter((m) => confirms(candidate, m, me)).map((m) => m.id), originalAt: original.sentAt, liveSession: original.live?.sessionId, remote: true }
    if (!ledger.records.some((r) => equivalent(r, record) && r.remote)) ledger.records.push(record)
    changed = true
    return false
  })
  return changed
}

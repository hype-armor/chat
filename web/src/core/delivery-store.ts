import type { AtomicStorageMutation, SecureStore } from './storage'

// This adapter is unintegrated and does not establish atomic delivery. The caller must serialize the
// entire commit with account and session lifecycle changes. It must enforce
// ownership for every writer and use a session generation that is never reused.
// Every relevant writer must use this fence. Reads are not a snapshot: stage
// against the supplied revision and discard staged values after any error or
// lifecycle change, including when a duplicate is returned. Capacity exhaustion fails closed until a separately proven
// retention and recovery policy exists.
const LEDGER_KEY = 'delivery-acceptance-ledger-v1'
export const DELIVERY_FENCE = 'delivery-acceptance-v1'
const MAX_ENTRIES = 4096
const MAX_BYTES = 1024 * 1024

export type DeliveryIntent = { id: string; kind: string; payload: string }
type Entry = { id: string; digest: string; intents: DeliveryIntent[] }
type Binding = { accountId: string; sessionGeneration: string }
type Ledger = Binding & { version: 1; entries: Entry[] }
type Store = Pick<SecureStore, 'getBytes' | 'atomicRevision' | 'atomicUpdate'>

// The intrinsic getter accepts ArrayBuffer objects from other realms, but rejects
// SharedArrayBuffer objects. Shared bytes can change during a synchronous copy.
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!
function isPrivateBytes(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array)) return false
  try { arrayBufferByteLength.call(value.buffer); return true } catch { return false }
}
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
function validateEntry(value: unknown): asserts value is Entry {
  if (!value || typeof value !== 'object') throw new Error('Malformed delivery ledger')
  const e = value as Entry
  if (!validText(e.id) || typeof e.digest !== 'string' || !/^[a-f0-9]{64}$/.test(e.digest) || !Array.isArray(e.intents)) throw new Error('Malformed delivery ledger')
  const ids = new Set<string>()
  for (const intent of e.intents) {
    if (!intent || !validText(intent.id) || !validText(intent.kind) || typeof intent.payload !== 'string' || ids.has(intent.id)) throw new Error('Malformed delivery ledger')
    ids.add(intent.id)
  }
}
function decode(bytes: Uint8Array | undefined, binding: Binding): Ledger {
  if (bytes === undefined) return { version: 1, ...binding, entries: [] }
  if (bytes.length > MAX_BYTES) throw new Error('Delivery ledger capacity exceeded')
  let ledger: Ledger
  try { ledger = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Ledger } catch { throw new Error('Malformed delivery ledger') }
  if (!ledger || ledger.version !== 1 || !validText(ledger.accountId) || !validText(ledger.sessionGeneration) || !Array.isArray(ledger.entries) || ledger.entries.length > MAX_ENTRIES) throw new Error('Malformed delivery ledger')
  if (ledger.accountId !== binding.accountId || ledger.sessionGeneration !== binding.sessionGeneration) throw new Error('Delivery binding mismatch')
  const ids = new Set<string>()
  const intentIds = new Set<string>()
  for (const entry of ledger.entries) {
    validateEntry(entry)
    if (ids.has(entry.id)) throw new Error('Malformed delivery ledger')
    ids.add(entry.id)
    for (const intent of entry.intents) {
      if (intentIds.has(intent.id)) throw new Error('Malformed delivery ledger')
      intentIds.add(intent.id)
    }
  }
  return ledger
}

/** The adapter hashes a copy of the exact envelope bytes.
 * Intents are data only; this adapter never dispatches effects or sends an ACK.
 * An error can have an uncertain commit outcome. Reconcile before retrying.
 * Other inputs must be trusted plain values without side-effecting getters.
 * SharedArrayBuffer-backed envelope and mutation bytes are rejected.
 */
export async function commitDelivery(store: Store, input: {
  revision: number
  id: string
  accountId: string
  sessionGeneration: string
  envelope: Uint8Array
  mutations: readonly AtomicStorageMutation[]
  intents: readonly DeliveryIntent[]
}): Promise<'committed' | 'duplicate'> {
  // Copy caller data before the first await.
  const binding = { accountId: input.accountId, sessionGeneration: input.sessionGeneration }
  if (!validText(binding.accountId) || !validText(binding.sessionGeneration)) throw new Error('Invalid delivery binding')
  if (!isPrivateBytes(input.envelope)) throw new Error('Invalid delivery envelope')
  const envelope = new Uint8Array(input.envelope)
  const intents = input.intents.map(i => ({ id: i.id, kind: i.kind, payload: i.payload }))
  const entry: Entry = { id: input.id, digest: '0'.repeat(64), intents }
  validateEntry(entry)
  const revision = input.revision
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid storage revision')
  const seen = new Set<string>()
  const mutations: AtomicStorageMutation[] = input.mutations.map(m => {
    if (!m || m.store !== 'kv' || typeof m.name !== 'string' || !m.name || m.name === LEDGER_KEY || (m.value !== undefined && !isPrivateBytes(m.value)) || seen.has(m.name)) throw new Error('Unsupported delivery mutation')
    seen.add(m.name)
    return { store: 'kv', name: m.name, value: m.value === undefined ? undefined : new Uint8Array(m.value) }
  })
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', envelope))
  entry.digest = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
  if (await store.atomicRevision(DELIVERY_FENCE) !== revision) throw new Error('Stale storage revision')
  const ledger = decode(await store.getBytes(LEDGER_KEY), binding)
  const previous = ledger.entries.find(e => e.id === entry.id)
  if (previous) {
    if (previous.digest !== entry.digest) throw new Error('Delivery envelope mismatch')
    if (await store.atomicRevision(DELIVERY_FENCE) !== revision) throw new Error('Stale storage revision')
    return 'duplicate'
  }
  const existingIntents = new Set(ledger.entries.flatMap(e => e.intents.map(i => i.id)))
  if (entry.intents.some(i => existingIntents.has(i.id))) throw new Error('Duplicate delivery intent')
  if (ledger.entries.length >= MAX_ENTRIES) throw new Error('Delivery ledger capacity exceeded')
  ledger.entries.push(entry)
  const encoded = new TextEncoder().encode(JSON.stringify(ledger))
  if (encoded.length > MAX_BYTES) throw new Error('Delivery ledger capacity exceeded')
  await store.atomicUpdate(DELIVERY_FENCE, revision, [...mutations, { store: 'kv', name: LEDGER_KEY, value: encoded }])
  return 'committed'
}

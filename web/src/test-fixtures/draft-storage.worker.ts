/// <reference lib="webworker" />
// Isolated browser regression only. Use production encryption and IndexedDB.
import { SecureStore } from '../core/storage'
import type { Draft } from '../core/protocol'

declare const self: DedicatedWorkerGlobalScope

const record = `draft:${'11'.repeat(16)}:${'22'.repeat(16)}`
const marker = 'draft-storage-regression-private-marker'

export type DraftStorageRequest = { id: number } & (
  | { type: 'write'; draft: Draft }
  | { type: 'read' }
)
export type DraftStorageReply = {
  id: number
  draft?: Draft
  inspection?: { sealedBytes: boolean; plaintextPresent: boolean; nonExtractableStorageKey: boolean }
  error?: string
}

// Raw inspection stays in this worker. Never send a key or ciphertext to the UI.
async function inspect(store: SecureStore, draft: Draft) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('chat', 2)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  let raw: unknown
  try {
    raw = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction('kv', 'readonly').objectStore('kv').get(record)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
  const sealedBytes = raw instanceof Uint8Array && raw.byteLength >= 28
  const decoded = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : JSON.stringify(raw) ?? ''
  const key = await store.getKey('storage')
  return {
    sealedBytes,
    plaintextPresent: decoded.includes(marker) || decoded.includes(JSON.stringify(draft)),
    nonExtractableStorageKey: key instanceof CryptoKey && key.type === 'secret' && key.algorithm.name === 'AES-GCM' && !key.extractable,
  }
}

let opening: Promise<SecureStore> | undefined
self.onmessage = async ({ data }: MessageEvent<DraftStorageRequest>) => {
  try {
    const store = await (opening ??= SecureStore.open())
    if (data.type === 'write') await store.putJson(record, data.draft)
    const draft = await store.getJson<Draft>(record)
    const reply: DraftStorageReply = {
      id: data.id,
      draft,
      inspection: draft ? await inspect(store, draft) : undefined,
    }
    self.postMessage(reply)
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) } satisfies DraftStorageReply)
  }
}

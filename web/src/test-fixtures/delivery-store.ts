import { SecureStore } from '../core/storage'
import { commitDelivery, DELIVERY_FENCE } from '../core/delivery-store'

const bytes = (s: string) => new TextEncoder().encode(s)
const input = (revision: number) => ({ revision, id: 'message', accountId: 'account', sessionGeneration: 'session-1', envelope: bytes('envelope'), mutations: [{ store: 'kv' as const, name: 'core', value: bytes('private core value') }], intents: [{ id: 'intent', kind: 'notify', payload: 'private intent value' }] })
const errorOf = async (fn: () => Promise<unknown>) => { try { await fn(); return '' } catch (error) { return String(error) } }

export async function commitAndAbort() {
  const store = await SecureStore.open()
  const committed = await commitDelivery(store, input(0))
  const put = IDBObjectStore.prototype.put
  let injected = false
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    const request = put.apply(this, args)
    if (!injected && this.name === 'kv') {
      injected = true
      const tx = this.transaction
      request.addEventListener('success', () => tx.abort(), { once: true })
    }
    return request
  }
  let aborted: string
  try { aborted = await errorOf(() => commitDelivery(store, { ...input(1), id: 'aborted', intents: [{ id: 'aborted-intent', kind: 'notify', payload: 'aborted' }], mutations: [{ store: 'kv', name: 'core', value: bytes('aborted value') }] })) }
  finally { IDBObjectStore.prototype.put = put }
  const stale = await errorOf(() => commitDelivery(store, { ...input(0), id: 'stale' }))
  return { committed, injected, aborted, stale }
}

export async function inspectAfterReload() {
  const store = await SecureStore.open()
  const revision = await store.atomicRevision(DELIVERY_FENCE)
  const core = new TextDecoder().decode(await store.getBytes('core'))
  const ledger = JSON.parse(new TextDecoder().decode(await store.getBytes('delivery-acceptance-ledger-v1')))
  const duplicate = await commitDelivery(store, input(revision))
  const mismatch = await errorOf(() => commitDelivery(store, { ...input(revision), envelope: bytes('different') }))
  const account = await errorOf(() => commitDelivery(store, { ...input(revision), accountId: 'other' }))
  const session = await errorOf(() => commitDelivery(store, { ...input(revision), sessionGeneration: 'session-2' }))
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('chat', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  const sealed = await Promise.all(['core', 'delivery-acceptance-ledger-v1'].map(name => new Promise<Uint8Array>((resolve, reject) => { const request = db.transaction('kv').objectStore('kv').get(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })))
  db.close()
  return { revision, core, ledger, duplicate, mismatch, account, session, ciphertext: sealed.map(value => ({ bytes: value instanceof Uint8Array, text: new TextDecoder().decode(value) })), finalRevision: await store.atomicRevision(DELIVERY_FENCE) }
}

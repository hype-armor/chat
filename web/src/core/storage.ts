// Encrypted key-value storage in IndexedDB (docs/03-architecture.md §3).
// Values are sealed with AES-GCM under a non-extractable WebCrypto key that
// lives in the same database: script can use it but never read it out.

import { plain } from './ids'

const DB_NAME = 'chat'
const STORES = ['kv', 'keys'] as const

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function openDb(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME, 1)
  req.onupgradeneeded = () => {
    for (const name of STORES) {
      if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name)
    }
  }
  return request(req)
}

export class SecureStore {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly key: CryptoKey,
  ) {}

  static async open(): Promise<SecureStore> {
    const db = await openDb()
    const tx = db.transaction('keys', 'readonly')
    let key = (await request(tx.objectStore('keys').get('storage'))) as CryptoKey | undefined
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await request(db.transaction('keys', 'readwrite').objectStore('keys').put(key, 'storage'))
    }
    return new SecureStore(db, key)
  }

  async getBytes(name: string): Promise<Uint8Array | undefined> {
    const sealed = (await request(this.db.transaction('kv', 'readonly').objectStore('kv').get(name))) as
      | Uint8Array
      | undefined
    if (!sealed) return undefined
    const iv = sealed.slice(0, 12)
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this.key, sealed.slice(12)))
  }

  async putBytes(name: string, value: Uint8Array): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, plain(value)))
    const sealed = new Uint8Array(12 + ct.length)
    sealed.set(iv)
    sealed.set(ct, 12)
    await request(this.db.transaction('kv', 'readwrite').objectStore('kv').put(sealed, name))
  }

  async getJson<T>(name: string): Promise<T | undefined> {
    const bytes = await this.getBytes(name)
    return bytes && (JSON.parse(new TextDecoder().decode(bytes)) as T)
  }

  /** Deletes everything except the storage key (signing out). */
  async clear(): Promise<void> {
    await request(this.db.transaction('kv', 'readwrite').objectStore('kv').clear())
  }

  putJson(name: string, value: unknown): Promise<void> {
    return this.putBytes(name, new TextEncoder().encode(JSON.stringify(value)))
  }
}

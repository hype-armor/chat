// Encrypted key-value storage in IndexedDB (docs/03-architecture.md §3).
// Values are sealed with AES-GCM under a non-extractable WebCrypto key that
// lives in the same database: script can use it but never read it out.
// Attachments are kept as their sealed blobs (ADR-0024): their keys are in
// the message history, which is sealed like everything else.

import { plain } from './ids'

const DB_NAME = 'chat'
const STORES = ['kv', 'keys', 'files'] as const

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'))
  })
}

function openDb(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME, 2)
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
      const creating = db.transaction('keys', 'readwrite')
      const done = committed(creating)
      await Promise.all([request(creating.objectStore('keys').put(key, 'storage')), done])
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
    const tx = this.db.transaction('kv', 'readwrite')
    const done = committed(tx)
    // Request success is not acceptance: the transaction can still abort.
    await Promise.all([request(tx.objectStore('kv').put(sealed, name)), done])
  }

  /** Deletes a local encrypted record; resolves only after transaction completion. */
  async deleteBytes(name: string): Promise<void> {
    const tx = this.db.transaction('kv', 'readwrite')
    const done = committed(tx)
    await Promise.all([request(tx.objectStore('kv').delete(name)), done])
  }

  async getJson<T>(name: string): Promise<T | undefined> {
    const bytes = await this.getBytes(name)
    return bytes && (JSON.parse(new TextDecoder().decode(bytes)) as T)
  }

  /** A non-extractable CryptoKey kept beside the storage key (e.g. the backup key). */
  async getKey(name: string): Promise<CryptoKey | undefined> {
    return (await request(this.db.transaction('keys', 'readonly').objectStore('keys').get(name))) as
      | CryptoKey
      | undefined
  }

  async putKey(name: string, key: CryptoKey | undefined): Promise<void> {
    const tx = this.db.transaction('keys', 'readwrite')
    const done = committed(tx)
    const store = tx.objectStore('keys')
    const operation = key ? request(store.put(key, name)) : request(store.delete(name))
    await Promise.all([operation, done])
  }

  /** A sealed attachment, by message id. */
  async getFile(id: string): Promise<Blob | undefined> {
    const value = (await request(this.db.transaction('files', 'readonly').objectStore('files').get(id))) as
      | Blob
      | ArrayBuffer
      | undefined
    return value instanceof ArrayBuffer ? new Blob([value]) : value
  }

  async putFile(id: string, sealed: Blob | undefined): Promise<void> {
    const write = async (value?: Blob | ArrayBuffer) => {
      const tx = this.db.transaction('files', 'readwrite')
      const done = committed(tx)
      const store = tx.objectStore('files')
      const operation = value === undefined ? request(store.delete(id)) : request(store.put(value, id))
      await Promise.all([operation, done])
    }
    if (!sealed) return write()
    try {
      await write(sealed)
    } catch {
      // WebKit can't store Blobs in private (ephemeral) sessions: keep bytes.
      // Read them first: a transaction closes while it waits on other work.
      const bytes = await sealed.arrayBuffer()
      await write(bytes)
    }
  }

  /** Deletes everything except the storage key (signing out). */
  async clear(): Promise<void> {
    const tx = this.db.transaction(['kv', 'files'], 'readwrite')
    const done = committed(tx)
    await Promise.all([
      request(tx.objectStore('kv').clear()), request(tx.objectStore('files').clear()), done,
    ])
    await this.putKey('backup', undefined)
  }

  putJson(name: string, value: unknown): Promise<void> {
    return this.putBytes(name, new TextEncoder().encode(JSON.stringify(value)))
  }
}

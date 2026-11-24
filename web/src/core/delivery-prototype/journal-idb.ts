import type { JournalState, JournalStore } from './journal'

// Test-only adapter. Values are NOT encrypted. Do not use for application data.
// The caller creates the object store and initializes the record separately.
export class JournalIdb<A, P> implements JournalStore<A, P> {
  constructor(private db: IDBDatabase, private store: string, private key: IDBValidKey) {}
  read(): Promise<JournalState<A, P>> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.store, 'readonly')
      const request = tx.objectStore(this.store).get(this.key)
      tx.oncomplete = () => request.result === undefined ? reject(new Error('Missing journal')) : resolve(request.result as JournalState<A, P>)
      tx.onabort = () => reject(tx.error ?? new Error('Journal read aborted'))
    })
  }
  compareAndReplace(revision: number, next: JournalState<A, P>): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.store, 'readwrite')
      const object = tx.objectStore(this.store)
      let matched = false
      const request = object.get(this.key)
      request.onsuccess = () => {
        const current = request.result as JournalState<A, P> | undefined
        if (!current || current.revision !== revision) return
        matched = true
        object.put(next, this.key)
      }
      tx.oncomplete = () => resolve(matched)
      tx.onabort = () => reject(tx.error ?? new Error('Journal write aborted'))
    })
  }
}

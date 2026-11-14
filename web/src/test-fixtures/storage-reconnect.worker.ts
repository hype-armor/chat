/// <reference lib="webworker" />
// Isolated browser regression. All keys and IndexedDB access stay in this worker.
import { SecureStore } from '../core/storage'

declare const self: DedicatedWorkerGlobalScope

self.onmessage = async () => {
  try {
    const store = await SecureStore.open()
    // Close the real connection, not a mock. This is test-only access to the
    // connection so the next operation exercises production recovery.
    const connection = () => Reflect.get(store, 'db') as IDBDatabase
    const close = () => connection().close()
    const draft = { text: '  private reconnect draft\n', revision: 17 }
    await store.putJson('draft:reconnect', draft)
    close()
    await store.putJson('draft:reconnect', { ...draft, revision: 18 })
    close()
    const restored = await store.getJson<typeof draft>('draft:reconnect')
    close()
    const key = await store.getKey('storage')
    if (!key) throw new Error('Missing storage key')
    close()
    await store.putKey('backup', key)
    close()
    await store.putFile('reconnect', new Blob(['sealed attachment']))
    close()
    const file = await store.getFile('reconnect')
    close()
    await store.deleteBytes('draft:reconnect')
    const deleted = await store.getJson('draft:reconnect') === undefined
    close()
    await store.clear()
    const cleared = await store.getFile('reconnect') === undefined && await store.getKey('backup') === undefined
    const preservedKey = await store.getKey('storage')
    connection().close()
    self.postMessage({
      restored, deleted, cleared,
      file: await file?.text(),
      keyPreserved: preservedKey instanceof CryptoKey && !preservedKey.extractable,
    })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}

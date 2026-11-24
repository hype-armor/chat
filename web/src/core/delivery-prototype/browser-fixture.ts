import { DeliveryFence, type AtomicStore, type Snapshot } from './fence'

// Test-only adapter. It is not SecureStore and does not encrypt data.
const binding = { account: 'fixture', session: 'fixture' }
const opened = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('delivery-fence-fixture', 1)
  request.onupgradeneeded = () => request.result.createObjectStore('state')
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})
let failure: 'none' | 'abort' | 'after-commit' = 'none'
let failCall = 0
let calls = 0
const store: AtomicStore = {
  async read() {
    const db = await opened
    return new Promise<Snapshot>((resolve, reject) => {
      const tx = db.transaction('state', 'readonly')
      const object = tx.objectStore('state')
      const core = object.get('core'), seen = object.get('seen'), pending = object.get('pending')
      const revision = object.get('revision'), storedBinding = object.get('binding')
      tx.oncomplete = () => resolve({ binding: storedBinding.result ?? binding, revision: revision.result ?? 0, core: core.result ?? new Uint8Array([0]), seen: seen.result ?? [], pending: pending.result })
      tx.onabort = () => reject(tx.error ?? new Error('aborted'))
    })
  },
  async compareAndReplace(expectedRevision, snapshot) {
    const db = await opened
    const mode = ++calls === failCall ? failure : 'none'
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite')
      const object = tx.objectStore('state')
      let matched = false
      const current = object.get('revision')
      current.onsuccess = () => {
        if ((current.result ?? 0) !== expectedRevision) return
        matched = true
        object.put(snapshot.binding, 'binding')
        object.put(snapshot.revision, 'revision')
        object.put(snapshot.core, 'core')
        object.put(snapshot.seen, 'seen')
        snapshot.pending === undefined ? object.delete('pending') : object.put(snapshot.pending, 'pending')
        if (mode === 'abort') tx.abort()
      }
      tx.oncomplete = () => mode === 'after-commit' ? reject(new Error('uncertain')) : resolve(matched)
      tx.onabort = () => reject(tx.error ?? new Error('aborted'))
    })
  },
}
const restore = (bytes: Uint8Array) => {
  let n = bytes[0]
  return { receive: () => ++n, snapshot: () => new Uint8Array([n]) }
}
let fence: DeliveryFence<number> | undefined
let acknowledgements = 0, effects = 0
const api = {
  async open() { fence = await DeliveryFence.open(store, binding, restore) },
  async deliver() { await fence!.deliver('one', new Uint8Array(), async () => { effects++ }, () => { acknowledgements++ }) },
  async read() { const state = await store.read(); return { revision: state.revision, core: [...state.core], seen: state.seen.map(entry => entry.id), pending: state.pending ?? null } },
  fail(call: number, mode: typeof failure) { calls = 0; failCall = call; failure = mode },
  counts() { return { acknowledgements, effects } },
  allowed() { fence!.assertTransportAllowed() },
}
;(window as unknown as { deliveryFixture: typeof api }).deliveryFixture = api

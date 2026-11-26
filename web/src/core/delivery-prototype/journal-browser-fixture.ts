import { JournalIdb } from './journal-idb'
import { AcceptanceJournal, type JournalState } from './journal'

type App = { messages: string[] }
const binding = { account: 'fixture', session: 'one' }
const db = await new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('journal-isolated-fixture', 1)
  request.onupgradeneeded = () => request.result.createObjectStore('state')
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})
const initial: JournalState<App, string> = { binding, revision: 0, core: new Uint8Array([0]), app: { messages: [] }, seen: [] }
await new Promise<void>((resolve, reject) => {
  const tx = db.transaction('state', 'readwrite')
  const object = tx.objectStore('state')
  const get = object.get('journal')
  get.onsuccess = () => { if (get.result === undefined) object.put(initial, 'journal') }
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error)
})
const store = new JournalIdb<App, string>(db, 'state', 'journal')
const restore = (core: Uint8Array) => {
  let n = core[0]
  return { receive: () => ++n, snapshot: () => new Uint8Array([n]) }
}
let journal: Awaited<ReturnType<typeof open>> | undefined
const open = () => AcceptanceJournal.open(store, binding, restore, () => true)
let openError = ''
try { journal = await open() } catch (error) { openError = String(error) }
const api = {
  openError,
  async open() { journal = await open() },
  async deliver(fail: boolean) {
    await journal!.deliver('one', new Uint8Array([1]), (event, app) => ({ app: { messages: [...app.messages, String(event)] }, publications: ['view'] }), async () => { if (fail) throw new Error('publication failed') }, () => {})
  },
  async read() { const s = await store.read(); return { revision: s.revision, core: [...s.core], app: s.app, seen: s.seen.length, pending: s.pending?.id ?? null } },
  async race() {
    const state = await store.read()
    return Promise.all([store.compareAndReplace(state.revision, { ...state, revision: state.revision + 1 }), store.compareAndReplace(state.revision, { ...state, revision: state.revision + 1 })])
  },
}
;(window as unknown as { journalFixture: typeof api }).journalFixture = api

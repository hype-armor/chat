// Test-only worker. Real Engine, MLS bindings, WebCrypto, and SecureStore.
import init, { CoreClient, PendingClient } from '../core/pkg/chat_core.js'
import { Engine } from '../core/engine'
import { SecureStore } from '../core/storage'
import { makeIdentity, randomId, toHex } from '../core/ids'

type Frame = Parameters<Engine['onDeliver']>[0]
type Saved = { sender: number[]; conversation: number[]; message: number[]; envelope: number[] }
const equal = (a: Uint8Array | undefined, b: Uint8Array | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i])
const digest = async (bytes: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
const errorOf = async (fn: () => unknown) => { try { await fn(); return '' } catch (error) { return String(error) } }
const initialized = init()

async function raw() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('chat', 2)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await Promise.all(['core', 'app'].map(name => new Promise<Uint8Array>((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').get(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })))
  } finally { db.close() }
}

async function run(command: string) {
  await initialized
  const store = await SecureStore.open()
  if (command === 'seed') {
    const alice = new PendingClient().intoClient(makeIdentity('11'.repeat(16), '22'.repeat(16)))
    const bob = new PendingClient().intoClient(makeIdentity('33'.repeat(16), '44'.repeat(16)))
    const started = alice.startConversation([makeIdentity('33'.repeat(16), '44'.repeat(16))], bob.keyPackages(1), randomId())
    bob.receive(started.welcome)
    const engine = new Engine(() => {})
    const id = toHex(started.conversationId)
    engine['state'].conversations[id] = { id, peers: ['11'.repeat(16)], lastAt: 1 }
    const envelope = alice.sendGroupTopic(started.conversationId, 'private disabled topic', 1, 10, randomId())
    await store.putBatch([['core', bob.snapshot()], ['app', new TextEncoder().encode(JSON.stringify(engine['state']))]])
    await store.putJson('topic-fixture', { sender: Array.from(alice.snapshot()), conversation: Array.from(started.conversationId), message: Array.from(randomId()), envelope: Array.from(envelope) } satisfies Saved)
    return { digest: await digest(envelope) }
  }
  const saved = (await store.getJson<Saved>('topic-fixture'))!
  const id = toHex(new Uint8Array(saved.conversation))
  const frame = { conversationId: new Uint8Array(saved.conversation), messageId: new Uint8Array(saved.message), envelope: new Uint8Array(saved.envelope), welcome: false } as Frame
  const beforeCore = (await store.getBytes('core'))!
  const beforeApp = (await store.getBytes('app'))!
  const beforeRaw = await raw()
  const engine = new Engine(() => {})
  engine['core'] = CoreClient.restore(beforeCore)
  engine['state'] = JSON.parse(new TextDecoder().decode(beforeApp))
  engine['account'] = { accountId: '33'.repeat(16), deviceId: '44'.repeat(16), username: 'bob', displayName: 'Bob', token: '' }
  engine['store'] = store
  // This fixture has no transport or pending outbox. Delivery remains the real Engine path.
  engine['flushOutbox'] = async () => {}
  let acknowledgements = 0
  let closes = 0
  let ackReadback = Promise.resolve({ ackCoreReadback: false, ackAppReadback: false })
  const order: string[] = []
  engine['ws'] = {
    send: () => {
      acknowledgements++
      order.push('ack')
      const snapshot = engine['core']!.snapshot()
      const appSnapshot = new TextEncoder().encode(JSON.stringify(engine['state']))
      ackReadback = Promise.all([store.getBytes('core'), store.getBytes('app')]).then(([core, app]) => ({
        ackCoreReadback: equal(core, snapshot),
        ackAppReadback: equal(app, appSnapshot),
      }))
    },
    close: () => { closes++ },
  } as unknown as Engine['ws']
  let injected = false
  const put = IDBObjectStore.prototype.put
  const transaction = IDBDatabase.prototype.transaction
  // Register before SecureStore installs its completion handler. Browsers can
  // run promise microtasks between listeners, so a later listener is too late.
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    const tx = transaction.apply(this, args)
    if (tx.mode === 'readwrite' && tx.objectStoreNames.contains('kv')) {
      tx.addEventListener('complete', () => order.push('commit'), { once: true })
    }
    return tx
  }
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    const request = put.apply(this, args)
    if (this.name === 'kv' && args[1] === 'core') {
      if (command === 'abort') {
        const tx = this.transaction
        request.addEventListener('success', () => { injected = true; tx.abort() }, { once: true })
      }
    }
    return request
  }
  let error: string
  try { error = await errorOf(() => engine['onDeliver'](frame)) }
  finally {
    IDBObjectStore.prototype.put = put
    IDBDatabase.prototype.transaction = transaction
  }
  const afterCore = (await store.getBytes('core'))!
  const afterApp = (await store.getBytes('app'))!
  const afterRaw = await raw()
  const app = JSON.parse(new TextDecoder().decode(afterApp))
  const restored = CoreClient.restore(afterCore)
  const replayError = await errorOf(() => restored.receive(frame.envelope))
  let laterText = ''
  if (command === 'replay') {
    const alice = CoreClient.restore(new Uint8Array(saved.sender))
    const text = alice.sendText(frame.conversationId, 'ordinary text after topic', 11, randomId())
    // Use another fresh receiver. The negative replay probe must not affect this check.
    laterText = CoreClient.restore(afterCore).receive(text).text ?? ''
  }
  return {
    error, injected, acknowledgements, closes, order, ...await ackReadback,
    digest: await digest(frame.envelope),
    coreUnchanged: equal(beforeCore, afterCore), appUnchanged: equal(beforeApp, afterApp),
    ciphertextUnchanged: beforeRaw.every((bytes, i) => equal(bytes, afterRaw[i])),
    messageSeen: Array.isArray(app.seen) && app.seen.includes(toHex(frame.messageId)),
    conversationUnchanged: JSON.stringify(app.conversations[id]) === JSON.stringify({ id, peers: ['11'.repeat(16)], lastAt: 1 }),
    noTopic: !JSON.stringify(app).includes('private disabled topic'),
    noHistory: await store.getBytes('messages:' + id) === undefined,
    replayError, laterText,
  }
}

self.onmessage = async (event: MessageEvent<string>) => {
  try { self.postMessage({ result: await run(event.data) }) }
  catch (error) { self.postMessage({ error: String(error) }) }
}

import { SecureStore } from '../core/storage'

self.onmessage = async () => {
  try {
    // The Playwright test uses a fresh browser context and disposable origin.
    // Both openers must agree on the key even when the database starts empty.
    const [first, second] = await Promise.all([SecureStore.open(), SecureStore.open()])
    const bytes = (value: string) => new TextEncoder().encode(value)
    await Promise.all([
      first.putBatch([['from-first', bytes('first secret')]]),
      second.putBatch([['from-second', bytes('second secret')]]),
    ])
    const crossReads = {
      fromFirst: new TextDecoder().decode(await second.getBytes('from-first')),
      fromSecond: new TextDecoder().decode(await first.getBytes('from-second')),
    }
    const values = (value: string) => [
      { store: 'kv' as const, name: 'record', value: bytes(value) },
      { store: 'files' as const, name: 'attachment', value: new Blob([value]) },
    ]
    // Store an actual undefined value to test native presence semantics.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('chat', 2)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const storedKey = await new Promise<unknown>((resolve, reject) => {
      const req = raw.transaction('keys', 'readonly').objectStore('keys').get('storage')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const serializedKey = storedKey instanceof CryptoKey && !storedKey.extractable && storedKey.algorithm.name === 'AES-GCM'
    await new Promise<void>((resolve, reject) => {
      const tx = raw.transaction('keys', 'readwrite')
      tx.objectStore('keys').put(undefined, ['atomic-revision', 'corrupt'])
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
    raw.close()
    const invalid: string[] = []
    try { await first.atomicRevision('corrupt') } catch (error) { invalid.push(String(error)) }
    try { await first.atomicUpdate('corrupt', 0, values('invalid')) } catch (error) { invalid.push(String(error)) }
    const initial = await first.atomicRevision('fixture')
    const contenders = await Promise.allSettled([
      first.atomicUpdate('fixture', initial, values('first')),
      second.atomicUpdate('fixture', initial, values('second')),
    ])
    const winner = contenders[0].status === 'fulfilled' ? 'first' : 'second'
    const rejected = contenders.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => String(result.reason))

    // Abort after the first native write succeeds, but before transaction completion.
    const originalPut = IDBObjectStore.prototype.put
    let abortInjected = false
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      const req = originalPut.apply(this, args)
      if (!abortInjected && this.name === 'kv') {
        abortInjected = true
        const tx = this.transaction
        req.addEventListener('success', () => tx.abort(), { once: true })
      }
      return req
    }
    let abortError = ''
    try { await first.atomicUpdate('fixture', 1, values('aborted')) } catch (error) { abortError = String(error) }
    finally { IDBObjectStore.prototype.put = originalPut }

    const afterAbort = {
      revision: await second.atomicRevision('fixture'),
      kv: new TextDecoder().decode(await second.getBytes('record')),
      file: await (await second.getFile('attachment'))?.text(),
    }
    let completed = false
    const originalTransaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      const tx = originalTransaction.apply(this, args)
      if (tx.mode === 'readwrite' && tx.objectStoreNames.contains('kv') && tx.objectStoreNames.contains('files')) {
        tx.addEventListener('complete', () => { completed = true }, { once: true })
      }
      return tx
    }
    let completedOnReturn: boolean
    try {
      await first.atomicUpdate('fixture', 1, values('durable'))
      completedOnReturn = completed
    } finally { IDBDatabase.prototype.transaction = originalTransaction }
    const reopened = await SecureStore.open()
    const durable = {
      revision: await reopened.atomicRevision('fixture'),
      kv: new TextDecoder().decode(await reopened.getBytes('record')),
      file: await (await reopened.getFile('attachment'))?.text(),
    }
    self.postMessage({ crossReads, serializedKey, invalid, initial, statuses: contenders.map(result => result.status), rejected, winner, abortInjected, abortError, afterAbort, completedOnReturn, durable })
  } catch (error) { self.postMessage({ error: String(error) }) }
}

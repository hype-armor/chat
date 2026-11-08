/// <reference lib="webworker" />
// Isolated regression only. Encryption and keys stay in this worker.
import { openFile, prepareImage, sealFile } from '../core/attachments'
import init from '../core/pkg/chat_core.js'

const started = init()

declare const self: DedicatedWorkerGlobalScope
self.onmessage = async ({ data }: MessageEvent<File>) => {
  try {
    await started
    const prepared = await prepareImage(data)
    const original = prepared?.data ?? data
    const key = crypto.getRandomValues(new Uint8Array(32))
    const sealed = await sealFile(original, key)
    const blob = await openFile(sealed.body, key, sealed.size, sealed.digest, data.type)
    const input = new Uint8Array(await data.arrayBuffer())
    const output = new Uint8Array(await blob.arrayBuffer())
    const intact = input.length === output.length && input.every((value, i) => output[i] === value)
    self.postMessage({ blob, intact, prepared: !!prepared, thumbnail: prepared?.thumbnail.length ?? 0 })
  } catch (error) {
    self.postMessage({ error: String(error) })
  }
}

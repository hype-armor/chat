// Resumable transfers of sealed attachments (ADR-0025). Uploads larger
// than one part go up part by part and resume from what the server has;
// downloads come in byte ranges kept on the device, and resume from the
// last stored piece. Runs in the core worker.

import { ApiError, api } from './api'
import type { SecureStore } from './storage'

/** Uploads up to this size go in one request. Matches the server's part size. */
export const PART_BYTES = 8 * 1024 * 1024
/** Downloads are fetched and kept in pieces of this size. */
export const PIECE_BYTES = 4 * 1024 * 1024

export type Progress = (done: number, total: number) => void

/**
 * Uploads `body`; returns the blob id. `session` holds the upload id of an
 * earlier attempt (if any) and is told about a new one, so a later call
 * resumes instead of starting over.
 */
export async function upload(
  token: string,
  body: Blob,
  session: { id?: string; save: (id: string | undefined) => Promise<void> },
  progress: Progress,
): Promise<string> {
  if (body.size <= PART_BYTES) {
    const { blob_id } = await api.uploadBlob(token, body)
    progress(body.size, body.size)
    return blob_id
  }
  let id = session.id
  let received: number[] = []
  if (id) {
    try {
      received = (await api.uploadStatus(token, id)).received
    } catch (e) {
      // Expired (a day old) or unknown: start again.
      if (!(e instanceof ApiError && e.status === 404)) throw e
      id = undefined
    }
  }
  if (!id) {
    id = (await api.createUpload(token, body.size)).upload_id
    await session.save(id)
  }
  const parts = Math.ceil(body.size / PART_BYTES)
  const have = new Set(received)
  const partSize = (n: number) => Math.min(PART_BYTES, body.size - n * PART_BYTES)
  let done = received.reduce((sum, n) => sum + partSize(n), 0)
  progress(done, body.size)
  for (let n = 0; n < parts; n++) {
    if (have.has(n)) continue
    await api.uploadPart(token, id, n, body.slice(n * PART_BYTES, n * PART_BYTES + partSize(n)))
    done += partSize(n)
    progress(done, body.size)
  }
  const { blob_id } = await api.completeUpload(token, id)
  await session.save(undefined)
  return blob_id
}

const pieceKey = (id: string, n: number) => `${id}#${n}`

/**
 * Downloads a blob of `size` bytes into the device's store under `id`,
 * resuming from pieces kept by an earlier attempt.
 */
export async function download(
  token: string,
  blobId: string,
  size: number,
  store: SecureStore,
  id: string,
  progress: Progress,
): Promise<Blob> {
  const pieces = Math.max(1, Math.ceil(size / PIECE_BYTES))
  const kept: Blob[] = []
  for (let n = 0; n < pieces; n++) {
    let piece = await store.getFile(pieceKey(id, n))
    if (!piece) {
      progress(n * PIECE_BYTES, size)
      const from = n * PIECE_BYTES
      const to = Math.min(size, from + PIECE_BYTES)
      piece = await api.downloadBlobRange(token, blobId, from, to)
      if (piece.size !== to - from) throw new Error("This file doesn't match its message")
      await store.putFile(pieceKey(id, n), piece)
    }
    kept.push(piece)
  }
  const whole = new Blob(kept)
  await store.putFile(id, whole)
  for (let n = 0; n < pieces; n++) await store.putFile(pieceKey(id, n), undefined)
  progress(size, size)
  return whole
}

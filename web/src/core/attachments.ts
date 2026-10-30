// Images and files (ADR-0024): photos are re-drawn to drop their metadata,
// every file is sealed in the core before upload, and downloads are checked
// and opened piece by piece. Runs in the core worker.

import { AttachmentOpener, AttachmentSealer } from './pkg/chat_core.js'
import { plain } from './ids'

/** Largest file people can send (FR-MED-3). */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
/** Photos are scaled down to fit this many pixels on the longer edge, by quality setting. */
const PHOTO = { standard: { edge: 2560, quality: 0.85 }, high: { edge: 4096, quality: 0.92 } }
const THUMB_EDGE = 320
const SMALL_THUMB_EDGE = 160
/** Thumbnails travel inside the MLS message, so they stay small. */
export const MAX_THUMB_BYTES = 48 * 1024

/** Formats re-drawn on a canvas, which keeps only the pixels (FR-MED-8). */
const REDRAWN = /^image\/(jpeg|png|webp|avif|bmp|heic|heif|tiff)$/

export type PreparedImage = {
  /** What gets sent: re-encoded, or the original for GIFs (no EXIF). */
  data: Blob
  mime: string
  width: number
  height: number
  thumbnail: Uint8Array
}

/** Scales `width`×`height` down to fit `edge`, keeping the aspect ratio. */
export function fit(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** A file name safe to show and save: no path, no control characters. */
export function safeName(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

/** A MIME type to label a received file with; anything odd becomes generic. */
export function safeMime(mime: string): string {
  return /^[a-z]+\/[a-z0-9.+-]{1,80}$/.test(mime) ? mime : 'application/octet-stream'
}

/** Shown in the chat list and notifications. */
export function attachmentLabel(mime: string, name: string, voiceNote?: boolean): string {
  if (voiceNote) return 'Voice note'
  if (mime.startsWith('image/')) return 'Photo'
  if (mime.startsWith('video/')) return 'Video'
  if (mime.startsWith('audio/')) return 'Audio'
  return `File: ${name}`
}

/** Clips longer than this are refused. */
const MAX_DURATION_MS = 24 * 60 * 60_000
/** Thumbnails travel inside the MLS message (see MAX_THUMB_BYTES). */
export const MAX_RECEIVED_THUMB_BYTES = 64 * 1024

/** A duration from a message or the UI, if it is plausible. */
export function safeDuration(ms: number | undefined): number | undefined {
  return ms !== undefined && Number.isFinite(ms) && ms > 0 && ms <= MAX_DURATION_MS ? Math.round(ms) : undefined
}

/** Pixel sizes from a message or the UI, if plausible. */
export function safeSize(width?: number, height?: number): { width?: number; height?: number } {
  const ok = (n?: number) => n !== undefined && Number.isInteger(n) && n > 0 && n <= 20_000
  return ok(width) && ok(height) ? { width, height } : {}
}

/** `report.jpg` for a photo re-encoded from `report.png`. */
export function renamed(name: string, mime: string): string {
  const ext = mime === 'image/png' ? 'png' : 'jpg'
  const base = name.replace(/\.[^.]*$/, '') || 'photo'
  return `${base}.${ext}`
}

async function draw(bitmap: ImageBitmap, width: number, height: number, mime: string, quality: number) {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2D canvas')
  if (mime === 'image/jpeg') {
    // JPEG has no transparency: show transparent areas as white, not black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas.convertToBlob({ type: mime, quality })
}

async function thumbnailOf(bitmap: ImageBitmap): Promise<Uint8Array> {
  for (const [edge, quality] of [
    [THUMB_EDGE, 0.6],
    [SMALL_THUMB_EDGE, 0.5],
  ]) {
    const size = fit(bitmap.width, bitmap.height, edge)
    const blob = await draw(bitmap, size.width, size.height, 'image/jpeg', quality)
    if (blob.size <= MAX_THUMB_BYTES) return new Uint8Array(await blob.arrayBuffer())
  }
  return new Uint8Array()
}

/**
 * Re-draws a photo so only its pixels are sent: EXIF, GPS and other
 * metadata are dropped, orientation applied, and large photos scaled down.
 * Returns undefined for files this browser can't decode as images; those
 * are sent as plain files.
 */
export async function prepareImage(
  file: Blob,
  setting: keyof typeof PHOTO = 'standard',
): Promise<PreparedImage | undefined> {
  const gif = file.type === 'image/gif'
  if (!gif && !REDRAWN.test(file.type)) return undefined
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return undefined
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return undefined
  }
  try {
    const thumbnail = await thumbnailOf(bitmap)
    if (gif) {
      // Keeps the animation; GIF has no EXIF block.
      return { data: file, mime: 'image/gif', width: bitmap.width, height: bitmap.height, thumbnail }
    }
    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const { edge, quality } = PHOTO[setting]
    const size = fit(bitmap.width, bitmap.height, edge)
    const data = await draw(bitmap, size.width, size.height, mime, quality)
    return { data, mime: data.type || mime, ...size, thumbnail }
  } finally {
    bitmap.close()
  }
}

async function eachPiece(blob: Blob, fn: (piece: Uint8Array) => void) {
  const reader = blob.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    fn(value)
  }
}

/** Encrypts `data` under `key` (32 random bytes) for upload. */
export async function sealFile(data: Blob, key: Uint8Array): Promise<{ body: Blob; size: number; digest: Uint8Array }> {
  const sealer = new AttachmentSealer(key)
  try {
    const parts: Uint8Array<ArrayBuffer>[] = []
    await eachPiece(data, (piece) => parts.push(plain(sealer.push(piece))))
    const sealed = sealer.finish()
    parts.push(plain(sealed.tail))
    const result = { body: new Blob(parts), size: sealed.size, digest: sealed.digest }
    sealed.free()
    return result
  } finally {
    sealer.free()
  }
}

/** Decrypts a sealed file, checking it is exactly the one the message names. */
export async function openFile(
  body: Blob,
  key: Uint8Array,
  size: number,
  digest: Uint8Array,
  mime: string,
): Promise<Blob> {
  const opener = new AttachmentOpener(key, size, digest)
  try {
    const parts: Uint8Array<ArrayBuffer>[] = []
    await eachPiece(body, (piece) => parts.push(plain(opener.push(piece))))
    parts.push(plain(opener.finish()))
    return new Blob(parts, { type: mime })
  } finally {
    opener.free()
  }
}

/** Server blob ids are UUIDs; messages carry their 16 bytes. */
export function uuidToHex(uuid: string): string {
  const hex = uuid.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('malformed blob id')
  return hex
}

export function hexToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

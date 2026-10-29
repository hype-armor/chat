// Location metadata in MP4/QuickTime clips (ADR-0024 addendum). Phones
// record where a video was taken in the `moov` box: a `©xyz` box (QuickTime),
// a `loci` box (3GPP) or an ISO 6709 string under Apple's `mdta` keys. They
// are blanked in place, so every offset in the file stays valid.

const MAX_MOOV_BYTES = 64 * 1024 * 1024

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
}

function is(b: Uint8Array, at: number, type: number[]): boolean {
  return type.every((c, i) => b[at + i] === c)
}

const XYZ = [0xa9, 0x78, 0x79, 0x7a] // ©xyz
const LOCI = [0x6c, 0x6f, 0x63, 0x69] // loci
/** ISO 6709, e.g. `+37.3349-122.0090+012.345/`: latitude, longitude, altitude. */
const ISO6709 = /[+-]\d{2}\.\d{2,}[+-]\d{3}\.\d{2,}(?:[+-]\d+(?:\.\d+)?)?/g

/** Blanks location data in a `moov` box's bytes; returns how many were found. */
export function scrubLocation(moov: Uint8Array): number {
  let found = 0
  for (let i = 4; i + 4 <= moov.length; i++) {
    if (!is(moov, i, XYZ) && !is(moov, i, LOCI)) continue
    const size = u32(moov, i - 4)
    if (size < 8 || i - 4 + size > moov.length) continue
    moov.fill(0, i + 4, i - 4 + size)
    found++
  }
  // Single-byte decoding keeps string and byte offsets the same.
  const text = new TextDecoder('latin1').decode(moov)
  for (const m of text.matchAll(ISO6709)) {
    for (let j = 0; j < m[0].length; j++) {
      if (/\d/.test(m[0][j])) moov[m.index + j] = 0x30 // '0'
    }
    found++
  }
  return found
}

async function bytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer())
}

/**
 * Returns the clip with location data blanked, or the clip itself when it
 * has none (or isn't a well-formed MP4/QuickTime file).
 */
export async function scrubMp4(file: Blob): Promise<Blob> {
  let at = 0
  while (at + 8 <= file.size) {
    const head = await bytes(file, at, at + 16)
    let size = u32(head, 0)
    let header = 8
    if (size === 1) {
      if (head.length < 16) return file
      size = u32(head, 8) * 2 ** 32 + u32(head, 12)
      header = 16
    } else if (size === 0) {
      size = file.size - at
    }
    if (size < header || at + size > file.size) return file
    if (is(head, 4, [0x6d, 0x6f, 0x6f, 0x76])) {
      if (size > MAX_MOOV_BYTES) return file
      const moov = await bytes(file, at, at + size)
      if (scrubLocation(moov) === 0) return file
      return new Blob([file.slice(0, at), moov as Uint8Array<ArrayBuffer>, file.slice(at + size)], { type: file.type })
    }
    at += size
  }
  return file
}

/** MP4-family clips that may carry a location. */
export function isMp4(mime: string): boolean {
  return /^(video\/(mp4|quicktime|3gpp)|audio\/(mp4|x-m4a|3gpp))$/.test(mime)
}

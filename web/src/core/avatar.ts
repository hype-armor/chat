// Profile pictures: a small square JPEG, re-drawn here so that no metadata
// leaves the device. It travels inside the encrypted `Profile` message, so
// the server never sees it. Runs in the core worker.

/** Largest profile picture, in bytes (it travels inside one MLS message). */
export const MAX_AVATAR_BYTES = 32 * 1024

/** Edge length and JPEG quality to try, in order, until the picture fits. */
const STEPS: [edge: number, quality: number][] = [
  [256, 0.85],
  [256, 0.7],
  [192, 0.7],
  [128, 0.7],
]

/** Whether `bytes` is a JPEG picture of an acceptable size. */
export function isAvatar(bytes: Uint8Array): boolean {
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return jpeg && bytes.length <= MAX_AVATAR_BYTES
}

/**
 * Crops a photo to its centre square and draws it as a JPEG, dropping EXIF
 * and other metadata. Throws if the browser cannot read the photo.
 */
export async function prepareAvatar(file: Blob): Promise<Uint8Array> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error("This browser can't open that photo. Try a JPEG or PNG.")
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    if (side < 1) throw new Error('That photo is empty')
    const sx = (bitmap.width - side) / 2
    const sy = (bitmap.height - side) / 2
    for (const [edge, quality] of STEPS) {
      const canvas = new OffscreenCanvas(edge, edge)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2D canvas')
      // JPEG has no transparency: show transparent areas as white, not black.
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, edge, edge)
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, edge, edge)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
      if (blob.size <= MAX_AVATAR_BYTES) return new Uint8Array(await blob.arrayBuffer())
    }
    throw new Error('That photo is too detailed. Try another one.')
  } finally {
    bitmap.close()
  }
}

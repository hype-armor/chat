import { crc32, inflateSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { imageViewerPng } from './image-viewer-bytes'

it('supplies a complete PNG with valid chunk checksums and image data', () => {
  const png = Buffer.from(imageViewerPng)
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const types: string[] = []
  const imageData: Buffer[] = []
  let offset = 8
  while (offset < png.length) {
    const size = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const end = offset + 8 + size
    expect(end + 4).toBeLessThanOrEqual(png.length)
    expect(png.readUInt32BE(end), `${type} checksum`).toBe(crc32(png.subarray(offset + 4, end)))
    if (type === 'IDAT') imageData.push(png.subarray(offset + 8, end))
    types.push(type)
    offset = end + 4
  }
  expect(types).toEqual(['IHDR', 'IDAT', 'IEND'])
  expect(offset).toBe(png.length)
  // One filter byte and two grey/alpha bytes encode the single scanline.
  expect(inflateSync(Buffer.concat(imageData))).toEqual(Buffer.from([1, 255, 255]))
})

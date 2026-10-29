import { describe, expect, it } from 'vitest'
import { fit, hexToUuid, renamed, safeMime, safeName, uuidToHex } from './attachments'

describe('attachments', () => {
  it('scales down to fit, keeping the aspect ratio', () => {
    expect(fit(4000, 3000, 2560)).toEqual({ width: 2560, height: 1920 })
    expect(fit(300, 5000, 320)).toEqual({ width: 19, height: 320 })
    expect(fit(100, 50, 320)).toEqual({ width: 100, height: 50 })
    expect(fit(10_000, 1, 320)).toEqual({ width: 320, height: 1 })
  })

  it('cleans received names and types', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd')
    expect(safeName('C:\\Users\\me\\report.pdf')).toBe('report.pdf')
    expect(safeName('a\u0000b\u001fc.txt')).toBe('abc.txt')
    expect(safeName('..')).toBe('file')
    expect(safeName('x'.repeat(500))).toHaveLength(120)
    expect(safeMime('image/png')).toBe('image/png')
    expect(safeMime('text/html; charset=utf-8')).toBe('application/octet-stream')
    expect(safeMime('')).toBe('application/octet-stream')
  })

  it('renames re-encoded photos', () => {
    expect(renamed('IMG_0001.HEIC', 'image/jpeg')).toBe('IMG_0001.jpg')
    expect(renamed('shot.png', 'image/png')).toBe('shot.png')
    expect(renamed('', 'image/jpeg')).toBe('photo.jpg')
  })

  it('converts blob ids', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'
    expect(hexToUuid(uuidToHex(uuid))).toBe(uuid)
    expect(() => uuidToHex('nope')).toThrow()
  })
})

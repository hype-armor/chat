import { describe, expect, it } from 'vitest'
import { scrubLocation, scrubMp4 } from './mp4'

function box(type: string, body: Uint8Array | string): Uint8Array {
  const content = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const out = new Uint8Array(8 + content.length)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(content, 8)
  return out
}

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

describe('mp4 location scrubbing', () => {
  it('blanks ©xyz, loci and ISO 6709 strings in place', () => {
    const moov = box(
      'moov',
      cat(
        box('udta', cat(box('©xyz', '\u0000\u0012\u0015Ç+48.8584+002.2945/'), box('loci', 'Eiffel'))),
        box('meta', 'keys mdta com.apple.quicktime.location.ISO6709 data +37.3349-122.0090+012.345/'),
      ),
    )
    const before = moov.length
    expect(scrubLocation(moov)).toBe(3)
    expect(moov.length).toBe(before)
    const text = latin1(moov)
    expect(text).not.toContain('48.8584')
    expect(text).not.toContain('Eiffel')
    expect(text).not.toContain('37.3349')
    expect(text).toContain('+00.0000-000.0000+000.000/')
    expect(text).toContain('udta')
  })

  it('leaves clips without a location unchanged', async () => {
    const file = new Blob([cat(box('ftyp', 'isom'), box('moov', box('trak', 'nothing here')), box('mdat', 'x'))])
    expect(await scrubMp4(file)).toBe(file)
    const notMp4 = new Blob(['plain text that is not an mp4'])
    expect(await scrubMp4(notMp4)).toBe(notMp4)
  })

  it('rewrites only the moov box of a clip', async () => {
    const mdat = box('mdat', 'frames +12.3456+123.4567 inside media data')
    const file = new Blob([cat(box('ftyp', 'isom'), mdat, box('moov', box('©xyz', '+48.8584+002.2945/')))], {
      type: 'video/mp4',
    })
    const out = await scrubMp4(file)
    expect(out.size).toBe(file.size)
    expect(out.type).toBe('video/mp4')
    const text = latin1(new Uint8Array(await out.arrayBuffer()))
    expect(text).not.toContain('48.8584')
    // Media data is never touched.
    expect(text).toContain('+12.3456+123.4567')
  })
})

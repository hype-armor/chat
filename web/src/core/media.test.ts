import { describe, expect, it } from 'vitest'
import { clearBytes, frameTransform } from './media'

describe('call media frames', () => {
  it('leaves only the VP8 payload header readable', () => {
    expect(clearBytes('audio', undefined, 100)).toBe(0)
    expect(clearBytes('video', 'key', 100)).toBe(10)
    expect(clearBytes('video', 'delta', 100)).toBe(3)
    expect(clearBytes('video', 'key', 4)).toBe(4)
  })

  it('drops frames that fail instead of passing them on in the clear', async () => {
    const options = { conversationId: 'c', callId: 'k', direction: 'send', kind: 'audio' } as const
    const seen: number[][] = []
    const transform = frameTransform(options, (data) => {
      if (data[0] === 0) throw new Error('no key')
      return data.map((b) => b + 1)
    })
    const writer = transform.writable.getWriter()
    const reader = transform.readable.getReader()
    void writer.write({ data: new Uint8Array([0, 1]).buffer })
    void writer.write({ data: new Uint8Array([5, 6]).buffer })
    void writer.close()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen.push([...new Uint8Array(value.data)])
    }
    expect(seen).toEqual([[6, 7]])
  })
})

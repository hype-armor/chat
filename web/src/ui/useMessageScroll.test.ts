import { describe, expect, it, vi } from 'vitest'
import { firstVisibleMessage } from './useMessageScroll'

function child(bottom: number) {
  return { getBoundingClientRect: vi.fn(() => ({ bottom }) as DOMRect) } as unknown as Element
}

describe('firstVisibleMessage', () => {
  it('uses a strict bottom-edge comparison and returns the first matching child', () => {
    const children = [child(10), child(20), child(20), child(30)]
    expect(firstVisibleMessage(children, 0)).toBe(children[0])
    expect(firstVisibleMessage(children, 10)).toBe(children[1])
    expect(firstVisibleMessage(children, 19)).toBe(children[1])
    expect(firstVisibleMessage(children, 20)).toBe(children[3])
    expect(firstVisibleMessage(children, 29.5)).toBe(children[3])
    expect(firstVisibleMessage(children, 30)).toBeUndefined()
    expect(firstVisibleMessage(children, 100)).toBeUndefined()
  })

  it('handles empty and single-child collections', () => {
    expect(firstVisibleMessage([], 0)).toBeUndefined()
    const only = child(10)
    expect(firstVisibleMessage([only], 9)).toBe(only)
    expect(firstVisibleMessage([only], 10)).toBeUndefined()
  })

  it('searches a live array-like collection with logarithmic layout reads', () => {
    const count = 65536
    const inspected: number[] = []
    const rect = vi.fn(() => ({ bottom: 0 }) as DOMRect)
    const children = new Proxy({ length: count }, {
      get(target, property) {
        if (property === 'length') return target.length
        if (typeof property !== 'string' || !/^\d+$/.test(property)) throw new Error('Collection must not be copied or iterated')
        const index = Number(property)
        inspected.push(index)
        return { getBoundingClientRect: () => { rect(); return { bottom: index * 10 + 10 } } }
      },
    }) as unknown as ArrayLike<Element>
    const match = firstVisibleMessage(children, 500000)
    expect(match?.getBoundingClientRect().bottom).toBe(500010)
    expect(inspected.at(-1)).toBe(50000)
    // At most 17 probes, 1 result read, and the assertion's rectangle read.
    expect(inspected.length).toBeLessThanOrEqual(18)
    expect(rect.mock.calls.length).toBeLessThanOrEqual(18)
  })
})

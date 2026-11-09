import { describe, expect, it, vi } from 'vitest'
import { firstVisibleMessage, latestIncomingMessageId, messageBottomGap, nearMessageBottom, restoredHasNewMessages, restoreMessagePosition, type MessageScrollPosition } from './useMessageScroll'

function child(bottom: number) {
  return { getBoundingClientRect: vi.fn(() => ({ bottom }) as DOMRect) } as unknown as Element
}

describe('incoming messages while a conversation is unmounted', () => {
  const message = (id: string, from: string, kind?: 'notice') => ({ id, from, kind, text: id, sentAt: 1, status: 'received' as const })
  const saved: MessageScrollPosition = { top: 100, bottom: false, newMessages: false, latestIncomingId: 'last' }

  it('detects new incoming messages without counting local sends or notices', () => {
    const history = [message('last', 'peer'), message('own', 'me'), message('notice', '', 'notice')]
    expect(latestIncomingMessageId(history)).toBe('last')
    expect(restoredHasNewMessages(saved, history)).toBe(false)
    expect(restoredHasNewMessages(saved, [...history, message('new', 'peer')])).toBe(true)
  })

  it('keeps an existing indicator and detects a first incoming message', () => {
    expect(restoredHasNewMessages({ ...saved, newMessages: true }, [message('last', 'peer')])).toBe(true)
    expect(restoredHasNewMessages({ ...saved, latestIncomingId: undefined }, [message('first', 'peer')])).toBe(true)
    expect(latestIncomingMessageId([])).toBeUndefined()
  })
})

describe('message bottom state', () => {
  it('shows the chevron even inside the auto-follow threshold', () => {
    expect(nearMessageBottom(1000, 450, 500)).toBe(true)
    expect(messageBottomGap(1000, 450, 500)).toBe(50)
    expect(messageBottomGap(1000, 500, 500)).toBe(0)
    expect(messageBottomGap(1000, 510, 500)).toBe(0)
    expect(nearMessageBottom(1000, 419, 500)).toBe(false)
  })
})

describe('restoreMessagePosition', () => {
  function fixture() {
    const list = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }) as DOMRect }
    const element = {
      getAttribute: () => null,
      querySelector: () => ({ getAttribute: () => 'message-20' }),
      getBoundingClientRect: () => ({ top: 700 - list.scrollTop }) as DOMRect,
    } as unknown as Element
    const saved: MessageScrollPosition = { top: 400, bottom: false, key: 'message-20', offset: 20, newMessages: false }
    return { list, element, saved }
  }

  it('restores a message offset after the message layout changes', () => {
    const { list, element, saved } = fixture()
    expect(restoreMessagePosition(list, [element], saved)).toBe(element)
    expect(list.scrollTop).toBe(580)
    expect(element.getBoundingClientRect().top - list.getBoundingClientRect().top).toBe(saved.offset)
  })

  it('uses the saved pixel position if the anchor no longer exists', () => {
    const { list, element, saved } = fixture()
    expect(restoreMessagePosition(list, [element], { ...saved, key: 'deleted' })).toBeUndefined()
    expect(list.scrollTop).toBe(saved.top)
  })

  it('does not choose an arbitrary child when the saved anchor has no key', () => {
    const { list, saved } = fixture()
    expect(restoreMessagePosition(list, [child(10)], { ...saved, key: undefined })).toBeUndefined()
    expect(list.scrollTop).toBe(saved.top)
  })
})

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

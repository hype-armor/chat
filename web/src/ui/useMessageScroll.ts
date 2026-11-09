import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../core/protocol'

export const nearMessageBottom = (height: number, top: number, viewport: number) => height - top - viewport <= 80
export const messageBottomGap = (height: number, top: number, viewport: number) => Math.max(0, height - top - viewport)

export type MessageScrollPosition = { top: number; bottom: boolean; key?: string; offset?: number; newMessages: boolean }
export type MessageScrollMemory = { positions: Map<string, MessageScrollPosition>; id: string; ready: boolean }

/** Message children have ordered bottom edges. Search without copying the live collection. */
export function firstVisibleMessage(children: ArrayLike<Element>, viewportTop: number): Element | undefined {
  let low = 0
  let high = children.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (children[middle].getBoundingClientRect().bottom > viewportTop) high = middle
    else low = middle + 1
  }
  return low < children.length ? children[low] : undefined
}

function scrollKey(element: Element): string | undefined {
  return (element.getAttribute('data-scroll-key') ?? element.querySelector('[data-scroll-key]')?.getAttribute('data-scroll-key')) ?? undefined
}

/** A stable message anchor survives reflow. Missing messages fall back to the saved pixel position. */
export function restoreMessagePosition(list: Pick<HTMLDivElement, 'scrollTop' | 'getBoundingClientRect'>, children: ArrayLike<Element>, saved: MessageScrollPosition): Element | undefined {
  list.scrollTop = saved.top
  const element = saved.key === undefined ? undefined : Array.from(children).find((child) => scrollKey(child) === saved.key)
  if (element && saved.offset !== undefined) {
    list.scrollTop += element.getBoundingClientRect().top - list.getBoundingClientRect().top - saved.offset
  }
  return element
}

/** Follow new content only while pinned. Local sends always override reading position. */
export function useMessageScroll(messages: ChatMessage[], panelOpen: boolean, memory?: MessageScrollMemory) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLOListElement>(null)
  const atBottom = useRef(true)
  const initialized = useRef(false)
  const lastScrollTop = useRef(0)
  const viewportSize = useRef({ width: 0, height: 0 })
  const previousMessages = useRef<ChatMessage[]>([])
  const [newMessages, setNewMessages] = useState(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const anchor = useRef<{ element: Element; offset: number } | undefined>(undefined)
  const positions = memory?.positions
  const id = memory?.id
  const ready = memory?.ready ?? true
  const unread = useRef(false)

  const save = useCallback(() => {
    const list = viewport.current
    if (!list || !initialized.current || !positions || id === undefined) return
    const saved = anchor.current
    positions.set(id, {
      top: list.scrollTop,
      bottom: messageBottomGap(list.scrollHeight, list.scrollTop, list.clientHeight) <= 1,
      key: saved ? scrollKey(saved.element) : undefined,
      offset: saved?.offset,
      newMessages: unread.current,
    })
  }, [positions, id])

  const capture = useCallback(() => {
    const list = viewport.current
    if (!list || !initialized.current) return
    // Ignore queued scroll events produced by our own programmatic scroll.
    if (list.scrollTop !== lastScrollTop.current) {
      atBottom.current = nearMessageBottom(list.scrollHeight, list.scrollTop, list.clientHeight)
    }
    lastScrollTop.current = list.scrollTop
    viewportSize.current = { width: list.clientWidth, height: list.clientHeight }
    setShowScrollToBottom(messageBottomGap(list.scrollHeight, list.scrollTop, list.clientHeight) > 1)
    const top = list.getBoundingClientRect().top
    const children = content.current?.children
    const element = children ? firstVisibleMessage(children, top) : undefined
    anchor.current = element ? { element, offset: element.getBoundingClientRect().top - top } : undefined
    save()
  }, [save])

  const scrollToBottom = useCallback(() => {
    atBottom.current = true
    unread.current = false
    setNewMessages(false)
    setShowScrollToBottom(false)
    const list = viewport.current
    if (list) {
      list.scrollTop = list.scrollHeight
      lastScrollTop.current = list.scrollTop
      viewportSize.current = { width: list.clientWidth, height: list.clientHeight }
    }
    save()
  }, [save])

  const restore = useCallback(() => {
    const list = viewport.current
    const saved = anchor.current
    if (!list || !saved?.element.isConnected) return
    list.scrollTop += saved.element.getBoundingClientRect().top - list.getBoundingClientRect().top - saved.offset
    lastScrollTop.current = list.scrollTop
    viewportSize.current = { width: list.clientWidth, height: list.clientHeight }
    setShowScrollToBottom(messageBottomGap(list.scrollHeight, list.scrollTop, list.clientHeight) > 1)
    save()
  }, [save])

  const consumePendingScroll = useCallback(() => {
    const list = viewport.current
    if (list && list.scrollTop !== lastScrollTop.current) {
      // A user scroll can precede both its scroll event and a ResizeObserver callback.
      // Our own scrolls update lastScrollTop synchronously. Native anchoring is disabled.
      capture()
      if (atBottom.current) {
        unread.current = false
        setNewMessages(false)
      }
    }
  }, [capture])

  const onScroll = useCallback(() => {
    const list = viewport.current
    if (!list) return
    const resized = list.clientWidth !== viewportSize.current.width || list.clientHeight !== viewportSize.current.height
    consumePendingScroll()
    if (resized) {
      if (atBottom.current) scrollToBottom()
      else restore()
    }
  }, [consumePendingScroll, restore, scrollToBottom])

  useLayoutEffect(() => {
    if (!ready) return
    const initial = !initialized.current
    const saved = initial && id !== undefined ? positions?.get(id) : undefined
    initialized.current = true
    const ids = new Set(previousMessages.current.map((m) => m.id))
    const added = messages.filter((m) => !ids.has(m.id))
    previousMessages.current = messages
    if (initial && saved && !saved.bottom && viewport.current) {
      atBottom.current = false
      unread.current = saved.newMessages
      setNewMessages(saved.newMessages)
      restoreMessagePosition(viewport.current, content.current?.children ?? [], saved)
      lastScrollTop.current = viewport.current.scrollTop
    } else if (initial || atBottom.current || added.some((m) => m.from === 'me')) scrollToBottom()
    else {
      restore()
      if (added.length) {
        unread.current = true
        setNewMessages(true)
      }
    }
    capture()
  }, [messages, panelOpen, ready, positions, id, capture, restore, scrollToBottom])

  // Layout cleanup runs before React removes the viewport. Capture queued user scrolls too.
  useLayoutEffect(() => () => capture(), [capture])

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (!initialized.current) return
      consumePendingScroll()
      if (atBottom.current) scrollToBottom()
      else restore()
    })
    if (content.current) observer.observe(content.current)
    if (viewport.current) observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [consumePendingScroll, restore, scrollToBottom])

  return { viewport, content, onScroll, capture, scrollToBottom, newMessages, showScrollToBottom }
}

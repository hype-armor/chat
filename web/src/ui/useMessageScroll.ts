import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../core/protocol'

export const nearMessageBottom = (height: number, top: number, viewport: number) => height - top - viewport <= 80

/** Follow new content only while pinned. Local sends always override reading position. */
export function useMessageScroll(messages: ChatMessage[], panelOpen: boolean) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLOListElement>(null)
  const atBottom = useRef(true)
  const lastScrollTop = useRef(0)
  const viewportSize = useRef({ width: 0, height: 0 })
  const previousMessages = useRef<ChatMessage[]>([])
  const [newMessages, setNewMessages] = useState(false)
  const anchor = useRef<{ element: Element; offset: number } | undefined>(undefined)

  const capture = useCallback(() => {
    const list = viewport.current
    if (!list) return
    // Ignore queued scroll events produced by our own programmatic scroll.
    if (list.scrollTop !== lastScrollTop.current) {
      atBottom.current = nearMessageBottom(list.scrollHeight, list.scrollTop, list.clientHeight)
    }
    lastScrollTop.current = list.scrollTop
    viewportSize.current = { width: list.clientWidth, height: list.clientHeight }
    const top = list.getBoundingClientRect().top
    const element = Array.from(content.current?.children ?? []).find((child) => child.getBoundingClientRect().bottom > top)
    anchor.current = element ? { element, offset: element.getBoundingClientRect().top - top } : undefined
  }, [])

  const scrollToBottom = useCallback(() => {
    atBottom.current = true
    setNewMessages(false)
    const list = viewport.current
    if (list) {
      list.scrollTop = list.scrollHeight
      lastScrollTop.current = list.scrollTop
      viewportSize.current = { width: list.clientWidth, height: list.clientHeight }
    }
  }, [])

  const restore = useCallback(() => {
    const list = viewport.current
    const saved = anchor.current
    if (!list || !saved?.element.isConnected) return
    list.scrollTop += saved.element.getBoundingClientRect().top - list.getBoundingClientRect().top - saved.offset
    lastScrollTop.current = list.scrollTop
    viewportSize.current = { width: list.clientWidth, height: list.clientHeight }
  }, [])

  const consumePendingScroll = useCallback(() => {
    const list = viewport.current
    if (list && list.scrollTop !== lastScrollTop.current) {
      // A user scroll can precede both its scroll event and a ResizeObserver callback.
      // Our own scrolls update lastScrollTop synchronously. Native anchoring is disabled.
      capture()
      if (atBottom.current) setNewMessages(false)
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
    const ids = new Set(previousMessages.current.map((m) => m.id))
    const added = messages.filter((m) => !ids.has(m.id))
    const initial = previousMessages.current.length === 0
    previousMessages.current = messages
    if (initial || atBottom.current || added.some((m) => m.from === 'me')) scrollToBottom()
    else {
      restore()
      if (added.length) setNewMessages(true)
    }
    capture()
  }, [messages, panelOpen, capture, restore, scrollToBottom])

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      consumePendingScroll()
      if (atBottom.current) scrollToBottom()
      else restore()
    })
    if (content.current) observer.observe(content.current)
    if (viewport.current) observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [consumePendingScroll, restore, scrollToBottom])

  return { viewport, content, onScroll, capture, scrollToBottom, newMessages }
}

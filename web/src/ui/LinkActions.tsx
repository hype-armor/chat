import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './linkActions.css'

const LONG_PRESS_MS = 550
const MOVE_LIMIT_PX = 10

/** Only an owned link gesture replaces the native callout. Never load a preview. */
export function LinkActions({ text, href }: { text: string; href: string }) {
  const link = useRef<HTMLAnchorElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const touch = useRef<{ id: number; x: number; y: number; phase: 'pending' | 'open' | 'cancelled' } | undefined>(undefined)
  const suppressClick = useRef(false)
  const [tracking, setTracking] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number }>()
  const [placed, setPlaced] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const selected = () => !!window.getSelection() && !window.getSelection()!.isCollapsed
  const cancelTimer = () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
  }
  const close = (restore = false) => {
    cancelTimer()
    if (touch.current) touch.current.phase = 'cancelled'
    setTracking(false)
    setPosition(undefined)
    if (restore) link.current?.focus({ preventScroll: true })
  }
  const open = (x: number, y: number) => {
    cancelTimer()
    setStatus('')
    setError('')
    setPlaced(false)
    setPosition({ x, y })
  }
  const ownTouch = () => touch.current?.phase === 'pending' || touch.current?.phase === 'open'

  useEffect(() => {
    if (!tracking && !position) return
    const move = (event: PointerEvent) => {
      const current = touch.current
      if (tracking && current && ownTouch() && (event.pointerId !== current.id || Math.hypot(event.clientX - current.x, event.clientY - current.y) > MOVE_LIMIT_PX)) close()
    }
    const finish = () => {
      cancelTimer()
      // Preserve ownership for selection/contextmenu delivered after pointerup.
      if (touch.current?.phase === 'pending') touch.current.phase = 'cancelled'
      setTracking(false)
    }
    const dismiss = () => close()
    const cancel = (event: PointerEvent) => {
      // A later touch can scroll a long menu after the initiating press ended.
      if (!tracking && event.target instanceof Node && menu.current?.contains(event.target)) return
      close()
    }
    const scroll = (event: Event) => {
      // Long action errors can scroll inside the menu without dismissing it.
      if (event.target instanceof Node && menu.current?.contains(event.target)) return
      close()
    }
    const outside = (event: Event) => {
      if (event.target instanceof Node && !link.current?.contains(event.target) && !menu.current?.contains(event.target)) close()
    }
    const selection = () => {
      if (!selected()) return
      if (!ownTouch()) close()
      else if (position) window.getSelection()?.removeAllRanges()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('selectionchange', selection)
    document.addEventListener('keydown', escape)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', dismiss)
    viewport?.addEventListener('scroll', dismiss)
    return () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', cancel)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('selectionchange', selection)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
      viewport?.removeEventListener('resize', dismiss)
      viewport?.removeEventListener('scroll', dismiss)
    }
  }, [tracking, position])

  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])

  useLayoutEffect(() => {
    if (!position || !menu.current) return
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const width = viewport?.width ?? window.innerWidth
    const height = viewport?.height ?? window.innerHeight
    // The keyboard can shrink the visual viewport without changing CSS dvh.
    menu.current.style.maxHeight = `${Math.max(0, height - 16)}px`
    menu.current.style.maxWidth = `${Math.max(0, width - 16)}px`
    // Measure away from the edge. Auto width otherwise shrinks to the old left
    // offset, then grows again when clamping moves the menu to the left.
    menu.current.style.left = `${left + 8}px`
    menu.current.style.top = `${top + 8}px`
    const bounds = menu.current.getBoundingClientRect()
    menu.current.style.left = `${Math.max(left + 8, Math.min(position.x, left + width - bounds.width - 8))}px`
    menu.current.style.top = `${Math.max(top + 8, Math.min(position.y, top + height - bounds.height - 8))}px`
    setPlaced(true)
  }, [position, status, error])

  useLayoutEffect(() => {
    if (position && placed) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [position, placed])

  const act = async (share: boolean) => {
    setError('')
    setStatus('')
    try {
      if (share) await navigator.share({ url: href })
      else {
        if (!navigator.clipboard) throw new Error('Clipboard is unavailable. Select the link to copy it.')
        await navigator.clipboard.writeText(href)
        setStatus('Link copied')
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'The action failed')
    }
  }

  return <span className="message-link">
    <a
      ref={link}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      aria-haspopup="menu"
      aria-expanded={!!position}
      aria-keyshortcuts="Shift+F10"
      onContextMenu={(event) => {
        event.stopPropagation()
        if (ownTouch()) {
          event.preventDefault()
          touch.current!.phase = 'open'
          suppressClick.current = true
          window.getSelection()?.removeAllRanges()
          open(event.clientX, event.clientY)
        } else if (touch.current?.phase !== 'cancelled' && !selected()) {
          event.preventDefault()
          open(event.clientX, event.clientY)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.stopPropagation()
          if (selected()) return
          event.preventDefault()
          touch.current = undefined
          const bounds = event.currentTarget.getBoundingClientRect()
          open(bounds.left + 8, bounds.top + 8)
        } else if (event.key === 'Enter') suppressClick.current = false
      }}
      onPointerDown={(event) => {
        // Parent message menus exclude anchors. Let document listeners dismiss other menus.
        cancelTimer()
        touch.current = undefined
        suppressClick.current = false
        const { pointerId: id, clientX: x, clientY: y } = event
        // Do not claim a gesture that began with an existing selection.
        if (selected()) {
          touch.current = { id, x, y, phase: 'cancelled' }
          return
        }
        if (!event.isPrimary || event.button !== 0 || event.pointerType === 'mouse') return
        touch.current = { id, x, y, phase: 'pending' }
        timer.current = setTimeout(() => {
          if (touch.current?.phase !== 'pending') return
          touch.current.phase = 'open'
          suppressClick.current = true
          window.getSelection()?.removeAllRanges()
          open(x, y)
        }, LONG_PRESS_MS)
        setTracking(true)
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (suppressClick.current) event.preventDefault()
      }}
    >{text}</a>
    {position && createPortal(<div
      ref={menu}
      role="menu"
      aria-label="Link actions"
      className="link-actions-menu"
      style={{ left: position.x, top: position.y, visibility: placed ? 'visible' : 'hidden' }}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
        const current = items.indexOf(document.activeElement as HTMLElement)
        let next: number
        switch (event.key) {
          case 'ArrowDown': next = (current + 1) % items.length; break
          case 'ArrowUp': next = (current - 1 + items.length) % items.length; break
          case 'Home': next = 0; break
          case 'End': next = items.length - 1; break
          case 'Tab': close(true); return
          case ' ':
            // Anchors need explicit Space activation inside an ARIA menu.
            if (event.target instanceof HTMLAnchorElement && event.target.getAttribute('role') === 'menuitem') {
              event.preventDefault()
              event.stopPropagation()
              event.target.click()
            }
            return
          default: return
        }
        event.preventDefault()
        event.stopPropagation()
        items[next]?.focus()
      }}
    >
      <a role="menuitem" tabIndex={-1} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={() => close(true)}>Open</a>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => void act(false)}>Copy link</button>
      {typeof navigator.share === 'function' && <button type="button" role="menuitem" tabIndex={-1} onClick={() => void act(true)}>Share</button>}
      {status && <span role="status">{status}</span>}
      {error && <span role="alert">{error}</span>}
    </div>, document.body)}
  </span>
}

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './messageActions.css'
import { REACTION_EMOJI } from '../core/reactions'
import { reactionLabel } from './reactions'
import { useDeletionDeadline } from './deletion'

const LONG_PRESS_MS = 550
const MOVE_LIMIT_PX = 10
const NATIVE_TARGET = 'a, button, summary, input, textarea, select, [contenteditable], audio, video, img, canvas, iframe, [role="button"], [role="link"], [role="menu"]'

/** A message keeps native link/media gestures. Its own menu has no permanent trigger. */
export function MessageActions({ children, className, title, author, enabled, onReply, onReact, onDeleteForMe, onDeleteForEveryone, deleteForEveryoneUntil }: {
  children: ReactNode
  className: string
  title: string
  author: string
  enabled: boolean
  onReply?: () => void
  onReact?: (emoji: string) => void
  onDeleteForMe?: () => void
  onDeleteForEveryone?: () => void
  deleteForEveryoneUntil?: number
}) {
  const root = useRef<HTMLLIElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const reply = useRef<HTMLButtonElement>(null)
  const press = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined)
  const suppressClick = useRef(false)
  const ownedTouch = useRef(false)
  const cancelledTouch = useRef(false)
  const [position, setPosition] = useState<{ x: number; y: number }>()
  const [pending, setPending] = useState(false)
  const [placed, setPlaced] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const now = useDeletionDeadline(deleteForEveryoneUntil)
  const everyoneAvailable = !!onDeleteForEveryone && deleteForEveryoneUntil !== undefined && now <= deleteForEveryoneUntil

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = undefined
    setPending(false)
  }
  const cancelGesture = () => {
    if (ownedTouch.current) cancelledTouch.current = true
    ownedTouch.current = false
    cancelPress()
  }
  const close = (restore = false) => {
    cancelGesture()
    setPosition(undefined)
    setSelecting(false)
    if (restore) root.current?.focus({ preventScroll: true })
  }
  const nativeTarget = (target: EventTarget | null) => target instanceof Element && !!target.closest(NATIVE_TARGET)
  const selected = () => {
    const selection = window.getSelection()
    return !!selection && !selection.isCollapsed
  }
  const open = (x: number, y: number) => {
    cancelPress()
    setPlaced(false)
    setPosition({ x, y })
  }

  useEffect(() => {
    if (!enabled) close()
  }, [enabled])

  useEffect(() => {
    if (!pending && !position) return
    const move = (event: PointerEvent) => {
      const current = press.current
      if (current && (event.pointerId !== current.id || Math.hypot(event.clientX - current.x, event.clientY - current.y) > MOVE_LIMIT_PX)) cancelGesture()
    }
    const finish = () => {
      // Some browsers deliver text selection and contextmenu after pointerup.
      // A completed long press owns those follow-up events until dismissal.
      if (suppressClick.current && ownedTouch.current) cancelPress()
      else cancelGesture()
    }
    const dismiss = (event: Event) => {
      if ((event.type === 'scroll' || event.type === 'pointercancel') && event.target instanceof Node && menu.current?.contains(event.target)) return
      close()
    }
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !menu.current?.contains(event.target)) close()
    }
    const selection = () => {
      if (!selected()) return
      if (!ownedTouch.current) close()
      else if (position) window.getSelection()?.removeAllRanges()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && position) {
        event.preventDefault()
        close(true)
      }
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', dismiss)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('selectionchange', selection)
    document.addEventListener('keydown', escape)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', dismiss)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('selectionchange', selection)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [pending, position])

  useEffect(() => () => { if (press.current) clearTimeout(press.current.timer) }, [])

  useLayoutEffect(() => {
    if (!position || !menu.current) return
    const bounds = menu.current.getBoundingClientRect()
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const width = viewport?.width ?? window.innerWidth
    const height = viewport?.height ?? window.innerHeight
    menu.current.style.maxHeight = `${Math.max(0, height - 16)}px`
    menu.current.style.left = `${Math.max(left + 8, Math.min(position.x, left + width - bounds.width - 8))}px`
    menu.current.style.top = `${Math.max(top + 8, Math.min(position.y, top + height - bounds.height - 8))}px`
    setPlaced(true)
    const fit = () => {
      if (!menu.current) return
      const v = window.visualViewport
      const h = v?.height ?? window.innerHeight
      const w = v?.width ?? window.innerWidth
      const x = v?.offsetLeft ?? 0
      const y = v?.offsetTop ?? 0
      menu.current.style.maxHeight = Math.max(0, h - 16) + 'px'
      const rect = menu.current.getBoundingClientRect()
      menu.current.style.left = Math.max(x + 8, Math.min(position.x, x + w - rect.width - 8)) + 'px'
      menu.current.style.top = Math.max(y + 8, Math.min(position.y, y + h - rect.height - 8)) + 'px'
    }
    // Set max-height before reading the final bounds, including keyboard-only resizes.
    fit()
    viewport?.addEventListener('resize', fit)
    viewport?.addEventListener('scroll', fit)
    return () => {
      viewport?.removeEventListener('resize', fit)
      viewport?.removeEventListener('scroll', fit)
    }
  }, [position, selecting, everyoneAvailable])

  useLayoutEffect(() => {
    if (position && placed) menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [position, placed, selecting, everyoneAvailable])

  return <li
    ref={root}
    className={className}
    data-testid="message"
    title={title}
    tabIndex={enabled ? 0 : undefined}
    aria-label={`Message from ${author}`}
    aria-haspopup={enabled ? 'menu' : undefined}
    aria-expanded={enabled ? !!position : undefined}
    aria-keyshortcuts={enabled ? 'Shift+F10' : undefined}
    onContextMenu={(event) => {
      if (!enabled || nativeTarget(event.target)) return
      // A browser can start native text selection before our touch timer fires.
      // We own only a press that began without a selection on a plain message.
      if (ownedTouch.current || (suppressClick.current && position)) {
        event.preventDefault()
        suppressClick.current = true
        window.getSelection()?.removeAllRanges()
        open(event.clientX, event.clientY)
      } else if (!cancelledTouch.current && !selected()) {
        event.preventDefault()
        open(event.clientX, event.clientY)
      }
    }}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget || !enabled) return
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault()
        const bounds = event.currentTarget.getBoundingClientRect()
        open(bounds.left + 12, bounds.top + 12)
      }
    }}
    onPointerDown={(event) => {
      suppressClick.current = false
      cancelGesture()
      cancelledTouch.current = false
      if (!enabled || !event.isPrimary || event.button !== 0 || event.pointerType === 'mouse' || nativeTarget(event.target) || selected()) return
      const { pointerId: id, clientX: x, clientY: y } = event
      ownedTouch.current = true
      press.current = { id, x, y, timer: setTimeout(() => {
        suppressClick.current = true
        window.getSelection()?.removeAllRanges()
        open(x, y)
      }, LONG_PRESS_MS) }
      setPending(true)
    }}
    onClickCapture={(event) => {
      if (suppressClick.current && !nativeTarget(event.target)) {
        suppressClick.current = false
        event.preventDefault()
        event.stopPropagation()
      }
    }}
  >
    {children}
    {position && createPortal(<div
      className="message-actions-menu"
      ref={menu}
      role="menu"
      aria-label={selecting ? 'Choose reaction' : 'Message actions'}
      style={{ left: position.x, top: position.y, visibility: placed ? 'visible' : 'hidden' }}
      onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
            (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
          items[next]?.focus()
        } else if (event.key === 'Tab') close(true)
      }}
    >
      {selecting ? REACTION_EMOJI.map((emoji) => <button key={emoji} type="button" role="menuitem" tabIndex={-1}
        aria-label={reactionLabel(emoji)} onClick={() => { close(true); onReact?.(emoji) }}>{emoji} {reactionLabel(emoji)}</button>) : <>
        {onReply && <button ref={reply} type="button" role="menuitem" tabIndex={-1} onClick={() => { close(); onReply() }}>Reply</button>}
        {onReact && <button type="button" role="menuitem" tabIndex={-1} onClick={() => setSelecting(true)}>React</button>}
        {onDeleteForMe && <button type="button" role="menuitem" tabIndex={-1} onClick={() => { close(true); onDeleteForMe() }}>Delete for me</button>}
        {everyoneAvailable && <button type="button" role="menuitem" tabIndex={-1} onClick={() => { close(true); onDeleteForEveryone?.() }}>Delete for everyone</button>}
      </>}
    </div>, document.body)}
  </li>
}

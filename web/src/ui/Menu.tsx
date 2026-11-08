import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

export type MenuItem = {
  label: string
  onSelect: () => void
  danger?: boolean
  /** A toggle item. Omit for an ordinary command. */
  checked?: boolean
}

export function Menu({
  triggerLabel,
  triggerContent,
  items,
}: {
  triggerLabel: string
  triggerContent: ReactNode
  items: MenuItem[]
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const initialFocus = useRef(0)

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const element = menu.current
      const anchor = trigger.current
      if (!element || !anchor) return
      element.style.maxHeight = ''
      const bounds = element.getBoundingClientRect()
      const button = anchor.getBoundingClientRect()
      const cssMaximum = parseFloat(getComputedStyle(element).maxHeight)
      const viewport = window.visualViewport
      const top = viewport?.offsetTop ?? 0
      const bottom = top + (viewport?.height ?? window.innerHeight)
      // Preserve upward-opening attachment/call menus. Bound either placement
      // to the visible viewport instead of clipping the final keyboard actions.
      const available = bounds.bottom <= button.top
        ? bounds.bottom - top - 8
        : bottom - bounds.top - 8
      const maximum = Number.isFinite(cssMaximum) ? Math.min(available, cssMaximum) : available
      element.style.maxHeight = `${Math.max(0, maximum)}px`
      if (document.activeElement instanceof HTMLElement && element.contains(document.activeElement)) {
        document.activeElement.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }
    place()
    let frame: number | undefined
    const schedule = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => { frame = undefined; place() })
    }
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [open, items.length])

  useEffect(() => {
    if (!open) return
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]')
    const first = buttons?.[initialFocus.current === -1 ? buttons.length - 1 : 0]
    first?.focus({ preventScroll: true })
    first?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const outside = (event: Event) => {
      // An outside gesture can open another menu. Do not steal its focus.
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      close()
      return
    }
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? [])
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    switch (event.key) {
      case 'ArrowDown':
        next = (current + 1) % buttons.length
        break
      case 'ArrowUp':
        next = (current - 1 + buttons.length) % buttons.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = buttons.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    buttons[next]?.focus({ preventScroll: true })
    buttons[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  return (
    <div className="menu" ref={root}>
      <button
        type="button"
        className="icon"
        ref={trigger}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          initialFocus.current = 0
          if (open) close()
          else setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            initialFocus.current = event.key === 'ArrowUp' ? -1 : 0
            setOpen(true)
          }
        }}
      >
        {triggerContent}
      </button>
      {open && (
        <div className="menu-items" id={id} role="menu" aria-label={triggerLabel} ref={menu} onKeyDown={navigate}>
          {items.map((item) => (
            <button
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              tabIndex={-1}
              key={item.label}
              className={item.danger ? 'danger' : undefined}
              onClick={() => {
                close()
                item.onSelect()
              }}
            >
              {item.checked && <span aria-hidden="true">✓ </span>}{item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

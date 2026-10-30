import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'

export type MenuItem = {
  label: string
  onSelect: () => void
  danger?: boolean
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

  useEffect(() => {
    if (!open) return
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    buttons?.[initialFocus.current === -1 ? buttons.length - 1 : 0]?.focus()
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close()
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener('click', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('click', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      close()
      return
    }
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
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
    buttons[next]?.focus()
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
              role="menuitem"
              tabIndex={-1}
              key={item.label}
              className={item.danger ? 'danger' : undefined}
              onClick={() => {
                close()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

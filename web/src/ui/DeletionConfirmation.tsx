import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatMessage } from '../core/protocol'
import { canDeleteEveryone, deletionWarnings, useDeletionDeadline } from './deletion'
import { useModalBackground } from './useModalBackground'

export function DeletionConfirmation({ message, scope, onConfirm, onClose }: {
  message: ChatMessage
  scope: 'me' | 'everyone'
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const heading = useId()
  const description = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const now = useDeletionDeadline(message.deleteForEveryoneUntil)
  const expired = scope === 'everyone' && !canDeleteEveryone(message, now)
  const allowed = scope === 'me' ? message.canDeleteForMe === true : !expired
  useModalBackground(dialog, scrim, true)
  useLayoutEffect(() => { cancel.current?.focus({ preventScroll: true }) }, [])
  useLayoutEffect(() => {
    if (!allowed && dialog.current?.contains(document.activeElement)) cancel.current?.focus({ preventScroll: true })
  }, [allowed])
  return createPortal(<div className="deletion-scrim" ref={scrim}>
    <div className="deletion-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={heading} aria-describedby={description}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
        if (event.key === 'Tab') {
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          event.preventDefault()
          buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
        }
      }}>
      <h2 id={heading}>Delete for {scope === 'me' ? 'me' : 'everyone'}?</h2>
      <div id={description}>{deletionWarnings(message, scope).map((warning) => <p key={warning}>{warning}</p>)}</div>
      {expired && <p role="status">The 1-hour deletion window has ended. Cancel and use Delete for me instead.</p>}
      {busy && <p role="status">Accepting deletion on this device…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" ref={cancel} onClick={onClose}>Cancel</button>
        <button type="button" className="danger" disabled={busy || !allowed} onClick={() => {
          setBusy(true); setError(undefined)
          void onConfirm().catch((error: unknown) => {
            setError(error instanceof Error ? error.message : 'Deletion was not accepted. Try again.')
          }).finally(() => setBusy(false))
        }}>Delete for {scope === 'me' ? 'me' : 'everyone'}</button>
      </div>
    </div>
  </div>, document.body)
}

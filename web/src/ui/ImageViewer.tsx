// Raster image attachments. The core worker owns fetching and decryption.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CoreClient } from '../core/client'
import type { FileInfo } from '../core/protocol'
import './ImageViewer.css'

const callSelector = '.call-screen, .call-prompt'

/** Keep a URL alive only while its Blob is displayed. Never return a stale URL. */
function useObjectUrl(blob: Blob | undefined) {
  const [resource, setResource] = useState<{ blob: Blob; url: string }>()
  useEffect(() => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setResource({ blob, url })
    return () => URL.revokeObjectURL(url)
  }, [blob])
  return resource?.blob === blob ? resource?.url : undefined
}

export function ImageViewer({ src, name, busy, error, onRetry, onClose }: {
  src?: string
  name: string
  busy: boolean
  error?: string
  onRetry: () => void
  onClose: () => void
}) {
  const modal = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const callbacks = useRef({ onClose })
  callbacks.current = { onClose }
  const [failedSource, setFailedSource] = useState<string>()

  useLayoutEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const changed = new Set<HTMLElement>()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    let dismissed = false
    const restoreBackground = () => {
      for (const element of changed) element.inert = false
      changed.clear()
      document.body.style.overflow = previousOverflow
    }
    const synchronize = () => {
      const call = document.querySelector<HTMLElement>(callSelector)
      if (call) {
        // Calls take priority, including an incoming group call prompt.
        dismissed = true
        restoreBackground()
        callbacks.current.onClose()
        call.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
        return
      }
      if (dismissed) return
      for (const sibling of document.body.children) {
        if (sibling === modal.current || !(sibling instanceof HTMLElement) || sibling.inert) continue
        sibling.inert = true
        changed.add(sibling)
      }
    }
    const containFocus = () => {
      if (!dismissed && !modal.current?.contains(document.activeElement)) close.current?.focus({ preventScroll: true })
    }
    synchronize()
    if (!dismissed) close.current?.focus({ preventScroll: true })
    const observer = new MutationObserver(synchronize)
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('focusin', containFocus)
    return () => {
      observer.disconnect()
      document.removeEventListener('focusin', containFocus)
      restoreBackground()
      if (!document.querySelector(callSelector) && trigger?.isConnected && !trigger.closest('[inert]')) {
        trigger.focus({ preventScroll: true })
      }
    }
  }, [])

  useLayoutEffect(() => {
    // Removing a successful Retry button does not dispatch focusin. Keep the
    // keyboard in the dialog so Escape still works after loading completes.
    if (!document.querySelector(callSelector) && !modal.current?.contains(document.activeElement)) {
      close.current?.focus({ preventScroll: true })
    }
  }, [busy, error, src])

  return createPortal(
    <div
      ref={modal}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Image: ${name}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        } else if (event.key === 'Tab') {
          const buttons = [...(modal.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
          const first = buttons[0]
          const last = buttons.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }
      }}
    >
      <header className="image-viewer-toolbar">
        <span>{name}</span>
        <button ref={close} type="button" onClick={onClose} aria-label="Close image">Close</button>
      </header>
      <div className="image-viewer-content" aria-busy={busy}>
        {busy && <p role="status">Opening image…</p>}
        {error ? (
          <div className="image-viewer-error">
            <p role="alert">{error}</p>
            <button type="button" onClick={onRetry} disabled={busy}>Try again</button>
          </div>
        ) : src && failedSource === src ? (
          <p role="alert">This image cannot be displayed. Close the viewer to save the file.</p>
        ) : src ? (
          <img src={src} alt={name} data-full="true" onError={() => setFailedSource(src)} draggable={false} />
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

/** Use for both sent and received raster photos, inside the attachment renderer. */
export function ImageAttachment(props: {
  core: CoreClient
  conversationId: string
  messageId: string
  file: FileInfo
  sending: boolean
}) {
  // A different message must never reuse a decrypted Blob or an outstanding request.
  return <PhotoAttachment key={`${props.conversationId}:${props.messageId}`} {...props} />
}

function PhotoAttachment({ core, conversationId, messageId, file, sending }: Parameters<typeof ImageAttachment>[0]) {
  const thumbnail = useMemo(() => file.thumbnail ? new Blob([file.thumbnail], { type: 'image/jpeg' }) : undefined, [file.thumbnail])
  const [full, setFull] = useState<Blob>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [viewing, setViewing] = useState(false)
  const [progress, setProgress] = useState<number>()
  const thumbUrl = useObjectUrl(thumbnail)
  const fullUrl = useObjectUrl(full)
  const pending = useRef<Promise<Blob | undefined> | undefined>(undefined)
  const generation = useRef(0)
  const saveUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const urls = saveUrls.current
    return () => {
      generation.current++
      pending.current = undefined
      for (const [url, timer] of urls) {
        clearTimeout(timer)
        URL.revokeObjectURL(url)
      }
      urls.clear()
    }
  }, [])

  useEffect(() => core.subscribe((event) => {
    if (event.type === 'progress' && event.messageId === messageId) {
      setProgress(event.done < event.total ? event.done / event.total : undefined)
    }
  }), [core, messageId])

  const load = useCallback((): Promise<Blob | undefined> => {
    if (full) return Promise.resolve(full)
    if (pending.current) return pending.current
    const ticket = generation.current
    setBusy(true)
    setError(undefined)
    const request = core.openAttachment(conversationId, messageId).then((blob) => {
      if (ticket !== generation.current) return undefined
      setFull(blob)
      return blob
    }).catch((reason: unknown) => {
      if (ticket === generation.current) setError(reason instanceof Error ? reason.message : String(reason))
      return undefined
    }).finally(() => {
      if (ticket === generation.current) {
        setBusy(false)
        pending.current = undefined
      }
    })
    pending.current = request
    return request
  }, [core, conversationId, messageId, full])

  useEffect(() => {
    let active = true
    // StrictMode replays effects before this microtask. Do not start the worker
    // request for a discarded effect, or cache it across a real unmount.
    if (file.downloaded) queueMicrotask(() => { if (active) void load() })
    return () => { active = false }
  }, [file.downloaded, load])

  const save = async () => {
    const ticket = generation.current
    const blob = await load()
    if (!blob || ticket !== generation.current) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.name
    anchor.click()
    saveUrls.current.set(url, setTimeout(() => {
      URL.revokeObjectURL(url)
      saveUrls.current.delete(url)
    }, 60_000))
  }
  const aspect = file.width && file.height ? file.width / file.height : undefined
  const bytes = file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024
    ? `${Math.round(file.size / 1024)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`
  return (
    <div className="attachment" data-testid="attachment">
      <button
        type="button"
        className="photo"
        aria-label={`Show photo ${file.name}`}
        aria-haspopup="dialog"
        onClick={(event) => {
          if (document.querySelector(callSelector)) return
          // Safari does not focus buttons on pointer activation.
          event.currentTarget.focus({ preventScroll: true })
          setViewing(true)
          void load()
        }}
      >
        {fullUrl || thumbUrl ? <img
          src={fullUrl ?? thumbUrl}
          alt={file.name}
          data-full={!!fullUrl}
          style={{
            aspectRatio: aspect,
            width: aspect && file.width ? `min(${Math.max(file.width, 64 * Math.min(1, aspect))}px, calc(min(60vh, 22rem) * ${aspect}))` : undefined,
          }}
        /> : <span>Show photo {file.name}</span>}
      </button>
      <span className="small muted">
        {progress !== undefined && <span data-testid="transfer-progress">{sending ? 'Uploading' : 'Downloading'} {Math.floor(progress * 100)}% · </span>}
        {bytes} · <button type="button" className="link small" onClick={() => void save()} disabled={busy}>{busy ? 'Opening…' : 'Save'}</button>
      </span>
      {error && !viewing && <span className="small error" role="alert">{error}</span>}
      {viewing && <ImageViewer src={fullUrl} name={file.name} busy={busy || (!fullUrl && !error)} error={error} onRetry={() => void load()} onClose={() => setViewing(false)} />}
    </div>
  )
}

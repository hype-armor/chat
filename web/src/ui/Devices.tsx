import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import { parseLinkCode } from '../core/devices'
import type { DeviceInfo } from '../core/protocol'
import { MediaCapture, mediaAccessError, permissionGuidance } from './permissions'

const isLinkCode = (text: string) => parseLinkCode(text) !== undefined

/** This account's devices, and linking a new one (FR-ID-3/4, ADR-0019). */
export function Devices({ core }: { core: CoreClient }) {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [linking, setLinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const load = () =>
    core
      .devices()
      .then(setDevices)
      .catch(() => undefined)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      void load()
    }
  }

  return (
    <details className="devices" onToggle={(e) => (e.currentTarget.open ? void load() : undefined)}>
      <summary>Linked devices</summary>
      <ul aria-label="Devices">
        {devices.map((d, i) => (
          <li key={d.id}>
            <span>
              {d.current ? 'This device' : `Device ${i + 1}`}
              <span className="muted small">
                {' '}
                · added {d.addedOn}
                {d.lastSeenOn && !d.current ? ` · last active ${d.lastSeenOn}` : ''}
              </span>
            </span>
            {!d.current && (
              <button
                type="button"
                className="link small danger"
                disabled={busy}
                onClick={() => run(() => core.removeDevice(d.id))}
                aria-label={`Remove device ${i + 1}`}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {linking ? (
        <LinkNewDevice core={core} busy={busy} run={run} onDone={() => setLinking(false)} />
      ) : (
        <button type="button" className="link" onClick={() => setLinking(true)}>
          Link a new device
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </details>
  )
}

function LinkNewDevice({
  core,
  busy,
  run,
  onDone,
}: {
  core: CoreClient
  busy: boolean
  run: (action: () => Promise<void>) => Promise<void>
  onDone: () => void
}) {
  const [text, setText] = useState('')
  const [scanning, setScanning] = useState(false)
  const code = parseLinkCode(text)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!code) return
    void run(async () => {
      await core.approveLink(code)
      onDone()
    })
  }

  return (
    <form className="link-new" onSubmit={submit}>
      {scanning && !code && (
        <Scanner core={core} accept={isLinkCode} onCode={setText} onClose={() => setScanning(false)} />
      )}
      {!code ? (
        <>
          <button type="button" onClick={() => setScanning(true)} disabled={scanning}>
            Scan QR code
          </button>
          <label>
            Or type the code shown on the new device
            <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        </>
      ) : (
        <p role="note" className="notice">
          The new device will be able to read every message you receive from now on. Only continue if it's yours
          and you are holding it.
        </p>
      )}
      <span className="actions">
        <button type="submit" disabled={!code || busy}>
          {busy ? 'Linking…' : 'Link device'}
        </button>
        <button type="button" className="link" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </span>
    </form>
  )
}

/** Reads QR codes from the camera; frames are decoded in the core worker. */
export function Scanner({
  core,
  accept,
  onCode,
  onClose,
}: {
  core: CoreClient
  /** Codes this scanner is looking for; others are ignored. */
  accept: (text: string) => boolean
  onCode: (text: string) => void
  onClose: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string>()
  // Parent renders can replace callbacks without restarting camera access.
  const callbacks = useRef({ accept, onCode })
  callbacks.current = { accept, onCode }

  useEffect(() => {
    const capture = new MediaCapture()
    let timer: ReturnType<typeof setTimeout> | undefined
    let live = true
    const canvas = document.createElement('canvas')
    const scan = async () => {
      const v = video.current
      if (!live || !v) return
      if (v.videoWidth > 0) {
        const scale = Math.min(1, 640 / v.videoWidth)
        canvas.width = Math.round(v.videoWidth * scale)
        canvas.height = Math.round(v.videoHeight * scale)
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (ctx) {
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const text = await core.decodeQr(new Uint8Array(frame.data.buffer), frame.width, frame.height)
          if (live && text && callbacks.current.accept(text)) {
            capture.cancel()
            callbacks.current.onCode(text)
            return
          }
        }
      }
      if (live) timer = setTimeout(() => void scan().catch(failed), 250)
    }
    const failed = (error: unknown) => {
      capture.cancel()
      if (live) setError(`${mediaAccessError(error, 'camera')} Type the code instead.`)
    }
    // Skip StrictMode's discarded effect before it can open a second prompt.
    void Promise.resolve().then(async () => {
      if (!live) return
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this browser.')
      const stream = await capture.request({ video: { facingMode: 'environment' } })
      if (!stream || !live || !video.current) return
      video.current.srcObject = stream
      await video.current.play()
      await scan()
    }).catch(failed)
    return () => {
      live = false
      clearTimeout(timer)
      capture.cancel()
    }
  }, [core])

  return (
    <div className="scanner">
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : (
        <video ref={video} muted playsInline aria-label="Camera" />
      )}
      <p className="small muted">{permissionGuidance('camera')}</p>
      <button type="button" className="link" onClick={onClose}>
        Stop scanning
      </button>
    </div>
  )
}

import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import { parseLinkCode } from '../core/devices'
import type { DeviceInfo } from '../core/protocol'

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

  useEffect(() => {
    let stream: MediaStream | undefined
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
          if (live && text && accept(text)) {
            onCode(text)
            return
          }
        }
      }
      timer = setTimeout(() => void scan(), 250)
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        stream = s
        if (!live || !video.current) return
        video.current.srcObject = s
        void video.current.play()
        void scan()
      })
      .catch(() => live && setError('Camera unavailable; type the code instead.'))
    return () => {
      live = false
      clearTimeout(timer)
      for (const track of stream?.getTracks() ?? []) track.stop()
    }
  }, [core, accept, onCode])

  return (
    <div className="scanner">
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : (
        <video ref={video} muted playsInline aria-label="Camera" />
      )}
      <button type="button" className="link" onClick={onClose}>
        Stop scanning
      </button>
    </div>
  )
}

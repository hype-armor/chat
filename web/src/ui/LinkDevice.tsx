import { useEffect, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { LinkOffer } from '../core/protocol'

/** Link codes expire on the server after 10 minutes (ADR-0019). */
const OFFER_MS = 10 * 60_000

/** A QR code drawn as one SVG path (no markup injection, Trusted Types-safe). */
export function QrCode({ size, modules, label }: { size: number; modules: number[]; label: string }) {
  let d = ''
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y * size + x]) d += `M${x + 4} ${y + 4}h1v1h-1z`
  }
  const side = size + 8
  return (
    <svg className="qr" viewBox={`0 0 ${side} ${side}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={side} height={side} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

/** New device: shows a link code until a signed-in device approves it. */
export function LinkThisDevice({ core, onCancel }: { core: CoreClient; onCancel: () => void }) {
  const [offer, setOffer] = useState<LinkOffer>()
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setExpired(false)
    core
      .startLink()
      .then((o) => live && setOffer(o))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    const timer = setTimeout(() => live && setExpired(true), OFFER_MS)
    return () => {
      live = false
      clearTimeout(timer)
      void core.cancelLink()
    }
  }, [core, attempt])

  return (
    <section className="link-device" aria-label="Link this device">
      <h2>Link this device</h2>
      <p>
        On a device where you're already signed in, open <strong>Linked devices</strong>, choose{' '}
        <strong>Link a new device</strong> and scan this code.
      </p>
      {offer && !expired && (
        <>
          <QrCode size={offer.qrSize} modules={offer.qrModules} label="Link code" />
          <p className="muted small">
            No camera? Type this code instead:
            <br />
            <code className="link-code" data-testid="link-code">
              {offer.code}
            </code>
          </p>
          <p className="muted small" role="status">
            Waiting for approval…
          </p>
        </>
      )}
      {expired && (
        <p>
          This code expired.{' '}
          <button type="button" className="link" onClick={() => setAttempt((n) => n + 1)}>
            Show a new code
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="button" className="link" onClick={onCancel}>
        Sign up with a new account instead
      </button>
    </section>
  )
}

import { useState } from 'react'
import type { CoreClient } from '../core/client'
import type { InviteOffer } from '../core/protocol'
import { QrCode } from './LinkDevice'

/** Creates a single-use invite link to share, with its QR code (ADR-0021). */
export function Invite({ core }: { core: CoreClient }) {
  const [offer, setOffer] = useState<InviteOffer>()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const create = async () => {
    setBusy(true)
    setError(undefined)
    setCopied(false)
    try {
      setOffer(await core.createInvite())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="devices">
      <summary>Invite someone</summary>
      <p className="muted small">
        Chat is invite-only. Each link signs up one person and works for 7 days.
      </p>
      {offer && (
        <div className="invite">
          <QrCode size={offer.qrSize} modules={offer.qrModules} label="Invite link" />
          <code className="link-code" data-testid="invite-link">
            {offer.link}
          </code>
          <button
            type="button"
            className="link small"
            onClick={() => void navigator.clipboard?.writeText(offer.link).then(() => setCopied(true))}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
      <button type="button" onClick={() => void create()} disabled={busy}>
        {offer ? 'Create another invite' : 'Create invite link'}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </details>
  )
}

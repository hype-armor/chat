import { useCallback, useEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import { formatSafetyNumber } from '../core/keys'
import type { SafetyNumber, Verification } from '../core/protocol'
import { Scanner } from './Devices'
import { QrCode } from './LinkDevice'

const isVerifyCode = (text: string) => text.startsWith('chat-verify:')

export function VerificationBadge({ status }: { status?: Verification }) {
  if (status === 'verified') return <span className="badge small verified">Verified</span>
  if (status === 'changed') return <span className="badge small changed">Changed</span>
  return null
}

/** Compare or scan safety numbers with one contact (FR-ID-5, ADR-0020). */
export function Verify({
  core,
  conversationId,
  account,
  name,
  status,
  onDone,
}: {
  core: CoreClient
  conversationId: string
  account: string
  name: string
  status?: Verification
  onDone: () => void
}) {
  const [safety, setSafety] = useState<SafetyNumber>()
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string>()
  // A ref, so a new onDone from the parent doesn't restart the camera.
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    core
      .safetyNumber(conversationId, account)
      .then(setSafety)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [core, conversationId, account, status])

  const run = (action: () => Promise<void>) => async () => {
    setError(undefined)
    try {
      await action()
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const scanned = useCallback(
    (text: string) => {
      setScanning(false)
      setError(undefined)
      core.verifyScanned(conversationId, account, text).then(
        () => done.current(),
        (e) => setError(e instanceof Error ? e.message : String(e)),
      )
    },
    [core, conversationId, account],
  )

  return (
    <section className="verify" aria-label={`Verify ${name}`}>
      <p>
        Compare this number with {name}, in person or on a call. If it matches on both phones, your messages reach only
        their devices.
      </p>
      {safety && (
        <>
          <p className="safety-number" data-testid="safety-number">
            {formatSafetyNumber(safety.digits)}
          </p>
          <QrCode size={safety.qrSize} modules={safety.qrModules} label={`Safety number with ${name}`} />
        </>
      )}
      {scanning && <Scanner core={core} accept={isVerifyCode} onCode={scanned} onClose={() => setScanning(false)} />}
      <span className="actions">
        <button type="button" onClick={() => setScanning(true)} disabled={scanning || !safety}>
          Scan their code
        </button>
        {status !== 'verified' && (
          <button
            type="button"
            className="link"
            disabled={!safety}
            onClick={run(() => core.markVerified(conversationId, account))}
          >
            Mark as verified
          </button>
        )}
      </span>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  )
}

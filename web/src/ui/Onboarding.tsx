import { type FormEvent, useState } from 'react'
import type { CoreClient } from '../core/client'
import { LinkThisDevice } from './LinkDevice'

/** Phone verification (FR-ID-1). */
export function Onboarding({ core, notice }: { core: CoreClient; notice?: string }) {
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'phone' | 'code' | 'link'>('phone')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const run = (action: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="onboarding">
      <h1>Chat</h1>
      <p className="muted">End-to-end encrypted. Your messages never reach our servers in readable form.</p>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {step === 'link' ? (
        <LinkThisDevice core={core} onCancel={() => setStep('phone')} />
      ) : step === 'phone' ? (
        <form onSubmit={run(async () => {
          await core.requestCode(phone.trim())
          setStep('code')
        })}>
          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} autoComplete="name" />
          </label>
          <label>
            Phone number
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              type="tel"
              placeholder="+15551234567"
              pattern="\+[1-9][0-9]{7,14}"
              title="International format, starting with +"
              autoComplete="tel"
            />
          </label>
          <button type="submit" disabled={busy}>
            Send code
          </button>
          <button type="button" className="link" onClick={() => setStep('link')}>
            Already using Chat on another device? Link this one
          </button>
        </form>
      ) : (
        <form onSubmit={run(() => core.verify(phone.trim(), code.trim(), name.trim()))}>
          <p>We sent a 6-digit code to {phone}.</p>
          <label>
            Verification code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
            />
          </label>
          <button type="submit" disabled={busy}>
            Verify
          </button>
          <button type="button" className="link" onClick={() => setStep('phone')}>
            Use a different number
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  )
}

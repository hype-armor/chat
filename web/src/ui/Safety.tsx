import { type FormEvent, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { BlockedContact, ReportReason } from '../core/protocol'

/** Report someone, optionally with their recent messages (FR-ID-8). */
export function ReportForm({
  core,
  conversationId,
  account,
  name,
  blocked,
  onDone,
}: {
  core: CoreClient
  conversationId: string
  account: string
  name: string
  blocked: boolean
  onDone: (sent: boolean) => void
}) {
  const [reason, setReason] = useState<ReportReason>('spam')
  const [include, setInclude] = useState(true)
  const [alsoBlock, setAlsoBlock] = useState(!blocked)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await core.report(conversationId, account, reason, include)
      if (alsoBlock) await core.block(account)
      onDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="report" onSubmit={submit} aria-label={`Report ${name}`}>
      <fieldset>
        <legend>Why are you reporting {name}?</legend>
        {(
          [
            ['spam', 'Spam or scam'],
            ['harassment', 'Harassment or abuse'],
            ['other', 'Something else'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="choice">
            <input type="radio" name="reason" checked={reason === value} onChange={() => setReason(value)} />
            {label}
          </label>
        ))}
      </fieldset>
      <label className="choice">
        <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
        Include their last 10 messages in this chat. Messages are end-to-end encrypted, so we see only what you send.
      </label>
      {!blocked && (
        <label className="choice">
          <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} />
          Also block {name}
        </label>
      )}
      <span className="actions">
        <button type="submit" disabled={busy}>
          Send report
        </button>
        <button type="button" className="link" onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </button>
      </span>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  )
}

/** People this user blocked, to unblock them (FR-ID-8). */
export function BlockedList({ core }: { core: CoreClient }) {
  const [contacts, setContacts] = useState<BlockedContact[]>([])
  const load = () => core.blocked().then(setContacts, () => undefined)

  return (
    <details className="devices" onToggle={(e) => (e.currentTarget.open ? void load() : undefined)}>
      <summary>Blocked people</summary>
      <ul aria-label="Blocked people">
        {contacts.map((c) => (
          <li key={c.account}>
            <span>{c.name}</span>
            <button
              type="button"
              className="link small"
              onClick={() => core.unblock(c.account).then(load)}
              aria-label={`Unblock ${c.name}`}
            >
              Unblock
            </button>
          </li>
        ))}
      </ul>
      {contacts.length === 0 && <p className="muted small">Nobody is blocked.</p>}
    </details>
  )
}

/** Deleting the account and all its server data (FR-ID-9). */
export function DeleteAccount({ core }: { core: CoreClient }) {
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await core.deleteAccount(phone)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <details className="devices">
      <summary>Delete account</summary>
      <form className="report" onSubmit={submit}>
        <p className="small">
          This leaves all your chats and groups and deletes your account, devices and undelivered messages from our
          server. Messages on this device are erased. This can't be undone.
        </p>
        <label>
          Type your phone number to confirm
          <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" required autoComplete="off" />
        </label>
        <button type="submit" className="danger" disabled={busy}>
          {busy ? 'Deleting…' : 'Delete my account'}
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
    </details>
  )
}

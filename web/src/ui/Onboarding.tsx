import { type FormEvent, useState } from 'react'
import type { CoreClient } from '../core/client'
import { LinkThisDevice } from './LinkDevice'

/** The invite code from an invite link (`/#invite=<code>`), if any. */
function inviteFromLink(): string {
  return new URLSearchParams(location.hash.slice(1)).get('invite') ?? ''
}

/** Suggests a username from a display name: `alex.27`. */
export function suggestUsername(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 20)
  if (base.length < 3) return ''
  return `${base}.${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`
}

/** Sign-up with a username and an invite (FR-ID-1, ADR-0021). */
export function Onboarding({ core, notice }: { core: CoreClient; notice?: string }) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [invite, setInvite] = useState(inviteFromLink)
  const [linking, setLinking] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await core.signUp(username, name.trim(), invite)
      history.replaceState(null, '', location.pathname)
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
      {linking ? (
        <LinkThisDevice core={core} onCancel={() => setLinking(false)} />
      ) : restoring ? (
        <Restore core={core} onCancel={() => setRestoring(false)} />
      ) : (
        <form onSubmit={submit}>
          <label>
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => username || setUsername(suggestUsername(name))}
              required
              maxLength={64}
              autoComplete="name"
            />
          </label>
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              placeholder="alex.27"
              pattern="[A-Za-z][A-Za-z0-9_]{2,19}\.[0-9]{2,4}"
              title="A name of 3-20 letters, digits or _, then a dot and 2-4 digits, like alex.27"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <p className="muted small">
            People add you by your username, so share it only with people you want to hear from.
          </p>
          <label>
            Invite code
            <input
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="From your invite link"
            />
          </label>
          <button type="submit" disabled={busy}>
            Sign up
          </button>
          <button type="button" className="link" onClick={() => setLinking(true)}>
            Already using Chat on another device? Link this one
          </button>
          <button type="button" className="link" onClick={() => setRestoring(true)}>
            Lost your devices? Restore from backup
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

/** Restores an account from its backup onto this device (ADR-0022). */
function Restore({ core, onCancel }: { core: CoreClient; onCancel: () => void }) {
  const [username, setUsername] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await core.restore(username, recoveryKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} aria-label="Restore from backup">
      <p>
        Restoring signs out your other devices and brings back your chats as of the last backup. Your contacts' apps
        then add this device back to your conversations.
      </p>
      <label>
        Username
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <label>
        Recovery key
        <input
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.target.value)}
          required
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="ABCD-EFGH-…"
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? 'Restoring…' : 'Restore'}
      </button>
      <button type="button" className="link" onClick={onCancel}>
        Back
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  )
}

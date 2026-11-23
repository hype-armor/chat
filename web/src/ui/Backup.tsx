import { useState } from 'react'
import type { CoreClient } from '../core/client'

/** Encrypted backup under a recovery key (FR-MSG-13, ADR-0022). */
export function Backup({
  core,
  backup,
  username,
}: {
  core: CoreClient
  backup?: { lastAt?: number }
  username: string
}) {
  const [recoveryKey, setRecoveryKey] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="devices" open={recoveryKey !== undefined || undefined}>
      <summary>
        <span>Backup</span>
        <span className="setting-status">
          {backup?.lastAt ? `Last backup: ${new Date(backup.lastAt).toLocaleDateString()}` : backup ? 'No backup yet' : 'Off'}
        </span>
      </summary>
      {recoveryKey ? (
        <form
          className="recovery"
          aria-label="Save recovery key"
          onSubmit={(event) => {
            event.preventDefault()
            if (saved) setRecoveryKey(undefined)
          }}
        >
          <p className="small">
            Your recovery key. Save this username and recovery key in a password manager, or write the key down. It is
            the only way to restore your messages if you lose this device, and we cannot show it again.
          </p>
          <label>
            Username
            <input name="username" value={username} readOnly autoComplete="username" />
          </label>
          <label>
            Recovery key
            <input name="password" type="password" value={recoveryKey} readOnly autoComplete="new-password" />
          </label>
          <code className="link-code" data-testid="recovery-key">
            {recoveryKey}
          </code>
          <label className="choice">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I've stored my recovery key somewhere safe
          </label>
          <button type="submit" disabled={!saved}>
            Done
          </button>
        </form>
      ) : backup ? (
        <>
          <p className="muted small" data-testid="backup-status">
            {backup.lastAt ? `Last backup: ${new Date(backup.lastAt).toLocaleString()}` : 'No backup yet'}
          </p>
          <span className="actions">
            <button type="button" disabled={busy} onClick={() => run(() => core.backupNow())}>
              Back up now
            </button>
            <button
              type="button"
              className="link small danger"
              disabled={busy}
              onClick={() => run(() => core.turnOffBackup())}
            >
              Turn off backup
            </button>
          </span>
        </>
      ) : (
        <>
          <p className="muted small">
            If you lose all your devices, a backup restores your chats onto a new one. It's encrypted with a recovery
            key only you hold.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(async () => setRecoveryKey(await core.setupBackup()))}
          >
            Turn on backup
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </details>
  )
}

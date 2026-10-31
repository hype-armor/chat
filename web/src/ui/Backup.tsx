import { useState } from 'react'
import type { CoreClient } from '../core/client'

/** Encrypted backup under a recovery key (FR-MSG-13, ADR-0022). */
export function Backup({ core, backup }: { core: CoreClient; backup?: { lastAt?: number } }) {
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
        <div className="recovery">
          <p className="small">
            Your recovery key. Write it down or keep it in a password manager: it's the only way to restore your
            messages if you lose this device, and we can't show it again.
          </p>
          <code className="link-code" data-testid="recovery-key">
            {recoveryKey}
          </code>
          <label className="choice">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I've stored my recovery key somewhere safe
          </label>
          <button type="button" disabled={!saved} onClick={() => setRecoveryKey(undefined)}>
            Done
          </button>
        </div>
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

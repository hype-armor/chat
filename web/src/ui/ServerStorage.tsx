import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { CoreClient } from '../core/client'
import { quotaStatus, StorageLoader, storageBytes, type StorageState } from './serverStorage'
import './serverStorage.css'

export function ServerStorage({ core }: { core: Pick<CoreClient, 'storageUsage'> }) {
  const loader = useMemo(() => new StorageLoader(core), [core])
  const state = useSyncExternalStore(loader.subscribe, loader.snapshot, loader.snapshot)
  useEffect(() => {
    void loader.refresh()
    return () => loader.cancel()
  }, [loader])
  return <StorageUsageView state={state} refresh={() => void loader.refresh()} />
}

export function StorageUsageView({ state, refresh }: { state: StorageState; refresh: () => void }) {
  const { usage, loading, error } = state
  const status = usage && quotaStatus(usage)
  const total = usage ? usage.usedBytes + usage.reservedBytes : 0
  const notice = status === 'over'
    ? 'Storage quota exceeded. New uploads may be refused.'
    : status === 'full'
      ? 'Storage quota reached. New uploads may be refused.'
      : status === 'near'
        ? 'Storage is almost full. Upload reservations count toward your quota.'
        : undefined
  const amount = (bytes: number) => <span title={`${bytes.toLocaleString()} bytes`}>{storageBytes(bytes)}</span>
  return (
    <section className="server-storage" aria-label="Server storage">
      <div className="storage-heading">
        <h4>Server storage</h4>
        <button type="button" className="link small" disabled={loading} onClick={refresh} aria-label="Refresh server storage">
          Refresh
        </button>
      </div>
      <div role="status" className="muted small">
        {loading ? (usage ? 'Refreshing storage…' : 'Loading storage…') : error ? 'Storage usage unavailable' : 'Latest server snapshot'}
      </div>
      {usage && <>
        {(loading || error) && <p className="muted small">Showing the last loaded usage.</p>}
        <dl className="storage-totals">
          <div><dt>Used</dt><dd>{amount(usage.usedBytes)}</dd></div>
          <div><dt>Reserved for uploads</dt><dd>{amount(usage.reservedBytes)}</dd></div>
          <div><dt>Account quota</dt><dd>{usage.limitBytes === null ? 'Unlimited' : amount(usage.limitBytes)}</dd></div>
        </dl>
        {usage.limitBytes !== null && <progress
          aria-label="Server storage including upload reservations"
          max={usage.limitBytes || 1}
          value={usage.limitBytes === 0 ? 1 : Math.min(total, usage.limitBytes)}
        />}
        {notice && <p role="note" className="storage-warning">{notice}</p>}
        <p className="muted small">Encrypted files and backups on the server, not storage on this device. Reservations count toward the account quota.</p>
      </>}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  )
}

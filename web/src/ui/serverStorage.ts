import type { CoreClient } from '../core/client'
import type { StorageUsage } from '../core/protocol'

export type StorageState = { loading: boolean; usage?: StorageUsage; error?: string }

/** Ephemeral settings snapshot. Only the worker can read account usage. */
export class StorageLoader {
  private state: StorageState = { loading: true }
  private listeners = new Set<() => void>()
  private generation = 0
  private pending = false
  constructor(private core: Pick<CoreClient, 'storageUsage'>) {}
  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(state: StorageState) {
    this.state = state
    this.listeners.forEach((listener) => listener())
  }
  cancel() {
    this.generation++
    this.pending = false
  }
  async refresh() {
    if (this.pending) return
    this.pending = true
    const generation = ++this.generation
    this.update({ loading: true, usage: this.state.usage })
    try {
      const usage = await this.core.storageUsage()
      if (generation === this.generation) this.update({ loading: false, usage })
    } catch {
      if (generation === this.generation) {
        this.update({ loading: false, usage: this.state.usage, error: 'Could not load server storage. Try again.' })
      }
    } finally {
      if (generation === this.generation) this.pending = false
    }
  }
}

export function quotaStatus(usage: StorageUsage): 'unlimited' | 'normal' | 'near' | 'full' | 'over' {
  const total = usage.usedBytes + usage.reservedBytes
  if (usage.limitBytes === null) return 'unlimited'
  if (total > usage.limitBytes) return 'over'
  if (total === usage.limitBytes) return 'full'
  return total >= usage.limitBytes * 0.9 ? 'near' : 'normal'
}

/** Binary units match the server limits. Exact byte counts remain available. */
export function storageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const unit = Math.min(Math.floor(Math.log2(bytes) / 10) - 1, units.length - 1)
  return `${(bytes / 1024 ** (unit + 1)).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`
}

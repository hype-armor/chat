// Transient typing leases. The caller supplies authenticated MLS identities.
export const TYPING_TTL_MS = 8_000
export const TYPING_REFRESH_MS = 3_000
export const MAX_TYPING_TTL_MS = 10_000
const MAX_CLOCK_SKEW_MS = 2_000

export type TypingDetail = { activity: 'thinking' | 'working' | 'using'; tool?: string }
type Lease = { account: string; sentAt: number; expiresAt: number; detail?: TypingDetail }

// Treat all unknown combinations as generic typing, not an invalid lease.
export function typingDetail(activity: unknown, tool: unknown): TypingDetail | undefined {
  if ((activity === 'thinking' || activity === 'working') && tool == null) return { activity }
  if (activity === 'using' && typeof tool === 'string' && tool.length >= 1 && tool.length <= 64 && !/[^A-Za-z0-9_.:-]/.test(tool)) return { activity, tool }
  return undefined
}

/** Advance expiry through wall-clock rollback, without making old sender times fresh. */
export class TypingClock {
  private floor = 0
  private elapsedAt?: number

  now(wallNow = Date.now(), elapsedNow = performance.now()): number {
    const elapsed = this.elapsedAt === undefined ? 0 : Math.max(0, elapsedNow - this.elapsedAt)
    this.elapsedAt = elapsedNow
    this.floor = Math.max(wallNow, this.floor + elapsed)
    return this.floor
  }
}

export class TypingLeases {
  private devices = new Map<string, Lease>()
  private timeFloor = 0

  private time(now: number): number {
    this.timeFloor = Math.max(this.timeFloor, now)
    return this.timeFloor
  }

  update(device: string, account: string, active: boolean, sentAt: number, expiresAt: number, now: number, activity?: unknown, tool?: unknown) {
    now = this.time(now)
    if (!Number.isSafeInteger(sentAt) || !Number.isSafeInteger(expiresAt) || sentAt <= 0) return
    if (sentAt > now + MAX_CLOCK_SKEW_MS || sentAt < now - MAX_TYPING_TTL_MS) return
    if (expiresAt <= sentAt || expiresAt > sentAt + MAX_TYPING_TTL_MS || expiresAt <= now) return
    const old = this.devices.get(device)
    if (old && (old.sentAt > sentAt || (old.sentAt === sentAt && (active || old.expiresAt === 0)))) return
    // Retain stop tombstones briefly so delayed starts cannot revive them.
    this.devices.set(device, { account, sentAt, expiresAt: active ? Math.min(expiresAt, now + MAX_TYPING_TTL_MS) : 0, detail: active ? typingDetail(activity, tool) : undefined })
  }

  accounts(now: number, allowed: (device: string, account: string) => boolean): string[] {
    now = this.time(now)
    for (const [device, lease] of this.devices) {
      if (lease.sentAt < now - MAX_TYPING_TTL_MS || !allowed(device, lease.account)) this.devices.delete(device)
    }
    return [...new Set([...this.devices.values()].filter((l) => l.expiresAt > now).map((l) => l.account))].sort()
  }

  details(now: number, allowed: (device: string, account: string) => boolean): { account: string; detail?: TypingDetail }[] {
    const accounts = this.accounts(now, allowed)
    // A newer active device wins. Device ID resolves equal timestamps consistently.
    const devices = [...this.devices.entries()].sort(([a, x], [b, y]) => y.sentAt - x.sentAt || a.localeCompare(b))
    return accounts.map((account) => {
      const lease = devices.find(([, item]) => item.account === account && item.expiresAt > this.timeFloor)?.[1]
      return lease?.detail ? { account, detail: lease.detail } : { account }
    })
  }

  empty(now: number): boolean {
    now = this.time(now)
    for (const [device, lease] of this.devices) if (lease.sentAt < now - MAX_TYPING_TTL_MS) this.devices.delete(device)
    return this.devices.size === 0
  }

  stopDevice(device: string, account: string, sentAt: number, now: number) {
    this.update(device, account, false, sentAt, sentAt + MAX_TYPING_TTL_MS, now)
  }
}

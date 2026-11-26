// Transient recipient-side presence aggregation. This is not a transport or an
// audience authorization mechanism. Callers must authenticate both the account
// and device and check current consent before every update and read.
export type Presence = 'online' | 'away' | 'unknown'
export type ActivePresence = Exclude<Presence, 'unknown'>

export const MAX_PRESENCE_LEASE_MS = 60_000
const MAX_CLOCK_SKEW_MS = 2_000

type Lease = { account: string; state: ActivePresence | 'unknown'; sentAt: number; expiresAt: number }

export class PresenceLeases {
  private devices = new Map<string, Lease>()
  private timeFloor = 0

  private time(now: number): number {
    if (!Number.isSafeInteger(now) || now < 0) return this.timeFloor
    this.timeFloor = Math.max(this.timeFloor, now)
    return this.timeFloor
  }

  // sentAt and expiresAt must come from the authenticated event, not the
  // transport envelope. Unknown is an explicit stop and wins equal timestamps.
  update(device: string, account: string, state: Presence, sentAt: number, expiresAt: number, now: number): boolean {
    now = this.time(now)
    if (!device || !account || !['online', 'away', 'unknown'].includes(state)) return false
    if (!Number.isSafeInteger(sentAt) || !Number.isSafeInteger(expiresAt) || sentAt <= 0) return false
    if (sentAt > now + MAX_CLOCK_SKEW_MS || sentAt < now - MAX_PRESENCE_LEASE_MS) return false
    if (expiresAt <= sentAt || expiresAt > sentAt + MAX_PRESENCE_LEASE_MS || expiresAt <= now) return false
    const old = this.devices.get(device)
    if (old && (old.account !== account || old.sentAt > sentAt ||
      (old.sentAt === sentAt && (state !== 'unknown' || old.state === 'unknown')))) {
      // An exact replay of the active lease is still present in a poll.
      return old.account === account && old.sentAt === sentAt && old.state === state &&
        old.expiresAt === (state === 'unknown' ? 0 : expiresAt)
    }
    this.devices.set(device, { account, state, sentAt, expiresAt: state === 'unknown' ? 0 : expiresAt })
    return true
  }

  // Online wins over away. No live lease means unknown, never offline.
  get(account: string, now: number, allowed: (device: string, account: string) => boolean): Presence {
    now = this.time(now)
    let result: Presence = 'unknown'
    for (const [device, lease] of this.devices) {
      if (lease.sentAt < now - MAX_PRESENCE_LEASE_MS || !allowed(device, lease.account)) {
        this.devices.delete(device)
        continue
      }
      if (lease.account !== account || lease.expiresAt <= now) continue
      if (lease.state === 'online') result = 'online'
      else if (lease.state === 'away' && result !== 'online') result = 'away'
    }
    return result
  }

  // An omitted device is no longer live. Keep its ordering fence until the
  // authenticated timestamp is too old to accept again.
  retain(account: string, present: ReadonlySet<string>): void {
    for (const [device, lease] of this.devices) {
      if (lease.account === account && !present.has(device)) {
        this.devices.set(device, { ...lease, state: 'unknown', expiresAt: 0 })
      }
    }
  }

  // Clear on sign-out, account change, or loss of transport authorization.
  clear(): void {
    this.devices.clear()
  }
}

export type AuthenticatedPresenceEvent = {
  account: string
  device: string
  generation: string
  state: Presence
  sentAt: number
  expiresAt: number
}

/**
 * Experimental, in-memory recipient reconciliation only. This does not fetch,
 * decrypt, authorize, or persist anything. It must not enable presence transport.
 *
 * For each refresh, call begin(), fetch the complete poll, then independently
 * fetch the current grant from a strongly consistent authenticated endpoint.
 * Authenticate every event with MLS and validate its recipient and conversation
 * before passing it here. Apply only after the grant read completes. A null
 * generation means no grant, never an empty poll. On any failure call fail().
 * Invalidate on session, connection, roster or authorization changes. Callers
 * must recheck those bindings under their mutation lock before apply and get.
 */
export class PresenceReconciler {
  private leases = new PresenceLeases()
  private revision = 0
  private generation: string | null = null
  private highWater: bigint | null = null
  private revoked = false
  private ready = false

  constructor(private readonly sender: string) {}

  begin(): number {
    this.ready = false
    return ++this.revision
  }

  invalidate(): void {
    ++this.revision
    this.ready = false
    this.generation = null
    this.leases.clear()
  }

  fail(ticket: number): void {
    if (ticket === this.revision) this.invalidate()
  }

  apply(ticket: number, generation: string | null, events: readonly AuthenticatedPresenceEvent[], now: number,
    allowed: (device: string, account: string) => boolean): boolean {
    if (ticket !== this.revision) return false
    // Consume the ticket. A duplicate callback cannot replace a later snapshot.
    ++this.revision
    if (generation === null) {
      this.revoked = true
      this.invalidate()
      return false
    }
    if (!this.sender || !/^[1-9][0-9]{0,19}$/.test(generation)) {
      this.invalidate()
      return false
    }
    const value = BigInt(generation)
    // Keep this fence across failures and invalidations for this session.
    if (this.highWater !== null && (value < this.highWater || (this.revoked && value === this.highWater))) {
      this.invalidate()
      return false
    }
    if (this.generation !== generation) this.leases.clear()
    this.highWater = value
    this.revoked = false
    this.generation = generation
    const present = new Set<string>()
    for (const event of events) {
      if (event.account !== this.sender || event.generation !== generation || !event.device ||
          !allowed(event.device, event.account)) continue
      if (this.leases.update(event.device, event.account, event.state, event.sentAt, event.expiresAt, now)) {
        present.add(event.device)
      }
    }
    this.leases.retain(this.sender, present)
    this.ready = true
    return true
  }

  get(now: number, allowed: (device: string, account: string) => boolean): Presence {
    return this.ready ? this.leases.get(this.sender, now, allowed) : 'unknown'
  }
}

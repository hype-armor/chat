import { PresenceReconciler, type AuthenticatedPresenceEvent, type Presence } from './presence'

/** A complete, uncached poll for one sender. Ciphertext is opaque here. */
export type PresenceEnvelope<Ciphertext> = {
  device: string
  generation: string
  ciphertext: Ciphertext
}

export type PresenceGrant = {
  sender: string
  recipient: string
  recipientDevice: string
  // Null is an authoritative no-grant response, not a failed request.
  generation: string | null
}

/**
 * Callbacks run in the worker. They must use the same captured account, device,
 * session, connection, selected conversation and authenticated roster. Changes
 * to any binding must make isCurrent false and call invalidate immediately.
 *
 * authenticate must verify MLS sender, device, recipient, conversation,
 * generation, state and expiry. It must coordinate and persist MLS ratchet
 * state even when authentication fails, before resolving or rejecting. It must
 * serialize MLS access with all other traffic, including superseded refreshes.
 * currentGrant must make an independent, strongly consistent, authenticated,
 * non-cached read after the poll; it must not derive consent from the poll.
 * No callback may use the durable message queue as a fallback.
 */
export type PresenceClientDependencies<Ciphertext> = {
  poll: () => Promise<readonly PresenceEnvelope<Ciphertext>[]>
  authenticate: (envelope: PresenceEnvelope<Ciphertext>) => Promise<AuthenticatedPresenceEvent | null>
  currentGrant: () => Promise<PresenceGrant>
  isCurrent: () => boolean
  allowed: (device: string, account: string) => boolean
  now: () => number
}

/**
 * Experimental recipient-side refresh. It does not enable transport or UI.
 * Use a new instance for each captured session and sender. Only refresh returns
 * a result; a caller must independently schedule expiry and fresh authorization.
 * Revalidate the captured bindings under the caller's mutation lock before
 * publishing the returned result. Network and validation errors mean unknown.
 */
export class PresenceClient<Ciphertext> {
  private readonly reconciler: PresenceReconciler
  private revision = 0

  constructor(
    private readonly sender: string,
    private readonly recipient: string,
    private readonly recipientDevice: string,
    private readonly deps: PresenceClientDependencies<Ciphertext>,
  ) {
    this.reconciler = new PresenceReconciler(sender)
  }

  invalidate(): void {
    ++this.revision
    this.reconciler.invalidate()
  }

  // Undefined means a newer refresh or invalidation superseded this result.
  async refresh(): Promise<Presence | undefined> {
    const revision = ++this.revision
    const ticket = this.reconciler.begin()
    const fail = (): Presence | undefined => {
      if (revision !== this.revision) return undefined
      this.reconciler.invalidate()
      return 'unknown'
    }
    try {
      if (!this.sender || !this.recipient || !this.recipientDevice || !this.deps.isCurrent()) return fail()
      const envelopes = await this.deps.poll()
      if (revision !== this.revision) return undefined
      if (!this.deps.isCurrent() || !Array.isArray(envelopes) || envelopes.length > 10) return fail()
      const events: AuthenticatedPresenceEvent[] = []
      for (const envelope of envelopes) {
        const event = await this.deps.authenticate(envelope)
        if (revision !== this.revision) return undefined
        if (!this.deps.isCurrent()) return fail()
        if (event && event.account === this.sender && event.device === envelope.device &&
            event.generation === envelope.generation) events.push(event)
      }
      const grant = await this.deps.currentGrant()
      if (!this.deps.isCurrent() || grant.sender !== this.sender || grant.recipient !== this.recipient ||
          grant.recipientDevice !== this.recipientDevice) return fail()
      if (revision !== this.revision) return undefined
      if (!this.reconciler.apply(ticket, grant.generation, events, this.deps.now(), this.deps.allowed)) {
        return 'unknown'
      }
      if (!this.deps.isCurrent()) return fail()
      return this.reconciler.get(this.deps.now(), this.deps.allowed)
    } catch {
      return fail()
    }
  }
}

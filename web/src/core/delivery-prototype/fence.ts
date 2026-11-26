// Isolated model. This is not connected to Engine or SecureStore.
// Transport operations require external serialization across instances. The local
// assertion alone cannot detect another instance or guard an asynchronous send.
export type Binding = { account: string; session: string }
export type Snapshot = {
  binding: Binding
  revision: number
  core: Uint8Array
  seen: { id: string; digest: string }[]
  pending?: string
}
export interface AtomicStore {
  read(): Promise<Snapshot>
  // Compare and replace must be one atomic transaction. A rejection can mean
  // that the commit succeeded; false means the revision did not match.
  compareAndReplace(expectedRevision: number, snapshot: Snapshot): Promise<boolean>
}
export interface MlsCore<E> { receive(envelope: Uint8Array): E; snapshot(): Uint8Array }

// Do not evict IDs: accepting an evicted replay would repeat its effect.
// A full ledger requires a new session or an explicitly designed recovery.
export const MAX_REPLAY_ENTRIES = 1024

async function digest(envelope: Uint8Array): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new Uint8Array(envelope))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

export class DeliveryFence<E> {
  private poisoned = false
  private busy = false
  private constructor(private store: AtomicStore, private state: Snapshot, private core: MlsCore<E>) {}

  static async open<E>(store: AtomicStore, binding: Binding, restore: (bytes: Uint8Array) => MlsCore<E>): Promise<DeliveryFence<E>> {
    const state = await store.read()
    if (state.binding.account !== binding.account || state.binding.session !== binding.session) throw new Error('Delivery binding mismatch')
    if (state.pending !== undefined) throw new Error('Delivery effects require manual recovery')
    return new DeliveryFence(store, state, restore(state.core))
  }

  assertTransportAllowed(): void {
    if (this.poisoned || this.busy) throw new Error('Delivery session is fenced')
  }

  private async update(next: Snapshot): Promise<void> {
    if (!await this.store.compareAndReplace(this.state.revision, next)) throw new Error('Stale delivery instance')
    this.state = next
  }

  async deliver(id: string, envelope: Uint8Array, effect: (event: E) => Promise<void>, ack: () => void): Promise<void> {
    this.assertTransportAllowed()
    this.busy = true
    try {
      // Copy before hashing so caller mutation cannot change the processed bytes.
      const bytes = new Uint8Array(envelope)
      const hash = await digest(bytes)
      const seen = this.state.seen.find(entry => entry.id === id)
      if (seen && seen.digest !== hash) throw new Error('Delivery envelope mismatch')
      if (!seen && this.state.seen.length >= MAX_REPLAY_ENTRIES) throw new Error('Delivery replay ledger full')
      // Claim even duplicates, so stale instances cannot acknowledge them.
      await this.update({ ...this.state, revision: this.state.revision + 1, pending: id })
      if (!seen) {
        const event = this.core.receive(bytes)
        await effect(event)
      }
      const accepted: Snapshot = {
        ...this.state,
        revision: this.state.revision + 1,
        core: seen ? this.state.core : this.core.snapshot(),
        seen: seen ? this.state.seen : [...this.state.seen, { id, digest: hash }],
        pending: undefined,
      }
      await this.update(accepted)
      ack()
    } catch (error) {
      this.poisoned = true
      throw error
    } finally {
      this.busy = false
    }
  }
}

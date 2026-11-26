// Research prototype only. The caller must hold a cross-instance lock for the
// entire delivery and all transport, and invalidate `current` on sign-out.
// Stage must be synchronous and pure: no I/O, timers, UI or shared mutation.
import { MAX_REPLAY_ENTRIES, type Binding, type MlsCore } from './fence'

export type JournalState<A, P> = {
  binding: Binding
  revision: number
  core: Uint8Array
  app: A
  seen: { id: string; digest: string }[]
  // Publication is not assumed idempotent. A pending record needs recovery.
  pending?: { id: string; publications: P[] }
}
export interface JournalStore<A, P> {
  read(): Promise<JournalState<A, P>>
  compareAndReplace(revision: number, next: JournalState<A, P>): Promise<boolean>
}

export class AcceptanceJournal<E, A, P> {
  private busy = false
  private poisoned = false
  private constructor(private store: JournalStore<A, P>, private state: JournalState<A, P>, private restore: (bytes: Uint8Array) => MlsCore<E>, private current: () => boolean) {}

  static async open<E, A, P>(store: JournalStore<A, P>, binding: Binding, restore: (bytes: Uint8Array) => MlsCore<E>, current: () => boolean): Promise<AcceptanceJournal<E, A, P>> {
    const state = await store.read()
    if (!current()) throw new Error('Delivery lifecycle ended')
    if (state.binding.account !== binding.account || state.binding.session !== binding.session) throw new Error('Delivery binding mismatch')
    if (state.pending) throw new Error('Delivery publications require manual recovery')
    return new AcceptanceJournal(store, state, restore, current)
  }

  assertTransportAllowed(): void {
    if (this.busy || this.poisoned || !this.current()) throw new Error('Delivery session is fenced')
  }

  private check(): void { if (!this.current()) throw new Error('Delivery lifecycle ended') }
  private async update(next: JournalState<A, P>): Promise<void> {
    this.check()
    if (!await this.store.compareAndReplace(this.state.revision, next)) throw new Error('Stale delivery instance')
    this.state = next
    this.check()
  }

  async deliver(id: string, envelope: Uint8Array, stage: (event: E, app: A) => { app: A; publications: P[] }, publish: (publication: P) => Promise<void>, ack: () => void): Promise<void> {
    this.assertTransportAllowed()
    this.busy = true
    try {
      const bytes = new Uint8Array(envelope)
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
      this.check()
      const seen = this.state.seen.find(entry => entry.id === id)
      if (seen && seen.digest !== hash) throw new Error('Delivery envelope mismatch')
      if (!seen && this.state.seen.length >= MAX_REPLAY_ENTRIES) throw new Error('Delivery replay ledger full')
      let core = this.state.core, app = this.state.app, publications: P[] = []
      if (!seen) {
        // Restore a private copy. An exception must not mutate committed state.
        const stagedCore = this.restore(new Uint8Array(core))
        const result = stage(stagedCore.receive(bytes), structuredClone(app))
        core = stagedCore.snapshot()
        app = structuredClone(result.app)
        publications = structuredClone(result.publications)
      }
      // Even a duplicate claims the revision before acknowledgement. All staged
      // durable effects must be represented in app, not written by stage.
      await this.update({ ...this.state, revision: this.state.revision + 1, core, app,
        seen: seen ? this.state.seen : [...this.state.seen, { id, digest: hash }], pending: { id, publications } })
      for (const publication of publications) { this.check(); await publish(publication); this.check() }
      await this.update({ ...this.state, revision: this.state.revision + 1, pending: undefined })
      this.check()
      ack()
    } catch (error) {
      this.poisoned = true
      throw error
    } finally { this.busy = false }
  }
}

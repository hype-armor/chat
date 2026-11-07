import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { CoreClient } from '../core/client'
import type { Draft, ReplyPreview, TextSent } from '../core/protocol'

type Issue = { kind: 'load' | 'save' | 'send'; message: string }
type FailedDraft = { version: number; text: string; quote?: ReplyPreview; error: string }
export type DraftState = {
  text: string
  generation: number
  quote?: ReplyPreview
  failed: FailedDraft[]
  issue?: Issue
}
type Entry = {
  state: DraftState
  listeners: Set<() => void>
  queue: Promise<void>
  started: boolean
  initial: Promise<void>
  edited: boolean
  blocked: boolean
  known?: Draft
  acceptances: Map<number, Promise<Draft | undefined>>
  ownClears: Set<number>
}
type DraftCore = Pick<CoreClient, 'getDraft' | 'saveDraft' | 'sendText'>
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Session-only UI state. The worker owns all durable storage.
 * Keep this coordinator above the keyed Conversation. Its queues and send
 * snapshots must outlive the conversation view, but not the unlocked session.
 * CAS protects this engine only. It does not synchronize independent tabs.
 */
export class ConversationDrafts {
  private entries = new Map<string, Entry>()
  private active = true
  activate() { this.active = true }
  invalidate() { this.active = false }
  isActive() { return this.active }
  constructor(private core: DraftCore) {}

  private entry(id: string): Entry {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { state: { text: '', generation: 0, failed: [] }, listeners: new Set(), queue: Promise.resolve(), started: false, initial: Promise.resolve(), edited: false, blocked: false, acceptances: new Map(), ownClears: new Set() }
      this.entries.set(id, entry)
    }
    return entry
  }
  snapshot = (id: string) => this.entry(id).state
  subscribe(id: string, listener: () => void) {
    const entry = this.entry(id)
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener) }
  }
  private update(entry: Entry, patch: Partial<DraftState>) {
    if (!this.active) return
    entry.state = { ...entry.state, ...patch }
    entry.listeners.forEach((listener) => listener())
  }
  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const entry = this.entry(id)
    const result = entry.queue.then(task)
    entry.queue = result.then(() => {}, () => {})
    return result
  }
  private failure(entry: Entry, kind: 'load' | 'save', error: unknown) {
    entry.blocked = true
    this.update(entry, { issue: { kind, message: `Could not ${kind} this draft. ${message(error)}` } })
  }
  load(id: string): Promise<void> {
    const entry = this.entry(id)
    if (entry.started) return entry.initial
    entry.started = true
    entry.initial = this.enqueue(id, async () => {
      if (!this.active) return
      try {
        const loaded = await this.core.getDraft(id)
        if (!this.active) return
        this.merge(entry, loaded)
        if (!entry.edited) this.update(entry, { text: loaded.text })
      } catch (error) { this.failure(entry, 'load', error) }
    })
    return entry.initial
  }
  captureCaption(id: string): Promise<DraftState | undefined> {
    const entry = this.entry(id)
    const initial = this.load(id)
    // Do not capture an empty placeholder before the first restore completes.
    // Typing remains enabled; local edits still take precedence over restoration.
    if (entry.known) return Promise.resolve(entry.state)
    return initial.then(() => this.active && entry.known ? entry.state : undefined)
  }
  private merge(entry: Entry, draft: Draft) {
    if (!entry.known || draft.revision > entry.known.revision) entry.known = draft
  }
  private async persist(id: string, text: string): Promise<Draft> {
    const entry = this.entry(id)
    if (!this.active) throw new Error('The account session changed.')
    if (entry.blocked || !entry.known) throw new Error('Retry saving your draft before sending.')
    for (;;) {
      const expected = entry.known.revision
      const result = await this.core.saveDraft(id, text, expected)
      if (!this.active) throw new Error('The account session changed.')
      this.merge(entry, result.draft)
      if (result.applied) {
        if (entry.state.issue?.kind !== 'send') this.update(entry, { issue: undefined })
        return result.draft
      }
      // Only an independently confirmed local acceptance can authorize rebasing.
      // An unrelated CAS conflict still requires an explicit user retry.
      if (result.draft.text === '' && result.draft.revision === expected + 1) {
        const pending = entry.acceptances.get(expected)
        if (pending) await pending
        if (!this.active) throw new Error('The account session changed.')
        if (entry.ownClears.has(result.draft.revision)) continue
      }
      throw new Error('The saved draft changed. Your text is unchanged. Retry to save your text.')
    }
  }
  private prepare(id: string, text: string) {
    const entry = this.entry(id)
    return this.enqueue(id, async () => {
      if (!this.active) return undefined
      try { return await this.persist(id, text) }
      catch (error) { this.failure(entry, 'save', error); return undefined }
    })
  }
  private accept(id: string, saved: Draft, operation: (revision: number) => Promise<TextSent>) {
    const entry = this.entry(id)
    const acceptance = Promise.resolve().then(() => {
      if (!this.active) throw new Error('The account session changed.')
      return operation(saved.revision)
    })
    // This tracker does not hold the save queue during media preparation.
    const confirmation = acceptance.then((result) => {
      const draft = result.draft
      if (this.active) {
        if (draft) this.merge(entry, draft)
        // An empty snapshot can come from an unrelated writer. Only the
        // worker's explicit evidence can authorize a local-fence rebase.
        if (result.consumedRevision === saved.revision + 1) entry.ownClears.add(result.consumedRevision)
      }
      return draft
    }, () => undefined)
    entry.acceptances.set(saved.revision, confirmation)
    void confirmation.then(() => entry.acceptances.delete(saved.revision))
    return acceptance
  }
  private async reconcile(id: string, accepted: TextSent) {
    if (!this.active) return
    const entry = this.entry(id)
    try {
      const draft = accepted.draft ?? await this.core.getDraft(id)
      if (this.active) this.merge(entry, draft)
    } catch (error) { this.failure(entry, 'load', error) }
  }
  edit(id: string, text: string) {
    this.load(id)
    const entry = this.entry(id)
    entry.edited = true
    this.update(entry, { text, generation: entry.state.generation + 1, ...(entry.state.issue?.kind === 'send' ? { issue: undefined } : {}) })
    // Capture every edit, including identical and empty values. Never clear by
    // string equality. FIFO ordering covers writes, not asynchronous acceptance.
    void this.enqueue(id, async () => {
      if (!this.active || entry.blocked) return
      try { await this.persist(id, text) } catch (error) { this.failure(entry, 'save', error) }
    })
  }
  reply(id: string, quote: ReplyPreview | undefined) {
    const entry = this.entry(id)
    this.update(entry, { quote, generation: entry.state.generation + 1 })
  }
  retry(id: string) {
    const entry = this.entry(id)
    const text = entry.state.text
    const edited = entry.edited
    if (edited) this.update(entry, { generation: entry.state.generation + 1 })
    void this.enqueue(id, async () => {
      if (!this.active) return
      try {
        const loaded = await this.core.getDraft(id)
        if (!this.active) return
        this.merge(entry, loaded)
        entry.blocked = false
        if (!edited) {
          if (!entry.edited) this.update(entry, { text: loaded.text, issue: undefined })
        } else await this.persist(id, text)
      } catch (error) { this.failure(entry, 'save', error) }
    })
  }
  send(id: string): Promise<boolean> {
    this.load(id)
    const entry = this.entry(id)
    const submitted = entry.state
    if (!submitted.text.trim()) return Promise.resolve(false)
    const generation = submitted.generation + 1
    entry.edited = true
    // This empty composer is not itself a save. Until durable acceptance, the
    // worker retains the submitted text. New user edits enqueue separate saves.
    this.update(entry, { text: '', quote: undefined, generation, ...(entry.state.issue?.kind === 'send' ? { issue: undefined } : {}) })
    return this.prepare(id, submitted.text).then(async (saved) => {
      if (!saved) {
        this.recover(entry, submitted, generation, entry.state.issue?.message ?? 'Draft could not be saved.')
        return false
      }
      if (!this.active) return false
      let accepted: TextSent
      try {
        accepted = await this.accept(id, saved, (revision) => this.core.sendText(id, submitted.text.trim(), submitted.quote?.messageId, revision))
      } catch (error) {
        this.recover(entry, submitted, generation, message(error))
        this.update(entry, { issue: { kind: 'send', message: message(error) } })
        return false
      }
      // Acceptance is final. A later read failure cannot restore an accepted send.
      await this.reconcile(id, accepted)
      return true
    })
  }
  private recover(entry: Entry, submitted: DraftState, generation: number, error: string) {
    if (entry.state.generation === generation) {
      this.update(entry, { text: submitted.text, quote: submitted.quote, generation: generation + 1 })
    } else {
      this.update(entry, { failed: [...entry.state.failed, { version: generation, text: submitted.text, quote: submitted.quote, error }] })
    }
  }
  restore(id: string, version: number) {
    const entry = this.entry(id)
    const failed = entry.state.failed.find((item) => item.version === version)
    if (!failed || entry.state.text !== '' || entry.state.quote) return
    this.edit(id, failed.text)
    this.reply(id, failed.quote)
    this.discard(id, version)
  }
  discard(id: string, version: number) {
    const entry = this.entry(id)
    this.update(entry, { failed: entry.state.failed.filter((item) => item.version !== version) })
  }
  sendCaption(id: string, captured: Pick<DraftState, 'text' | 'generation'>, accept: (revision: number) => Promise<TextSent>): Promise<boolean> {
    this.load(id)
    const entry = this.entry(id)
    return this.prepare(id, captured.text).then(async (saved) => {
      if (!saved || !this.active) return false
      let accepted: TextSent
      try { accepted = await this.accept(id, saved, accept) }
      catch (error) {
        this.update(entry, { issue: { kind: 'send', message: message(error) } })
        return false
      }
      if (!this.active) return true
      if (entry.state.generation === captured.generation) {
        entry.edited = true
        this.update(entry, { text: '', generation: captured.generation + 1 })
      }
      await this.reconcile(id, accepted)
      return true
    })
  }
  /** Tests can await acknowledged work without arbitrary browser delays. */
  idle(id: string) { return this.entry(id).queue }
}

export function useConversationDraft(controller: ConversationDrafts, id: string) {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(id, listener), [controller, id])
  const snapshot = useCallback(() => controller.snapshot(id), [controller, id])
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => { controller.load(id) }, [controller, id])
  return state
}

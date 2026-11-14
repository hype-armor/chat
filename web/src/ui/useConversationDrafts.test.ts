import { describe, expect, it, vi } from 'vitest'
import type { Draft, TextSent } from '../core/protocol'
import { ConversationDrafts } from './useConversationDrafts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(initial = '') {
  const records = new Map<string, Draft>([['chat', { text: initial, revision: initial ? 1 : 0 }]])
  const read = (id: string) => ({ ...(records.get(id) ?? { text: '', revision: 0 }) })
  const core = {
    getDraft: vi.fn(async (id: string) => read(id)),
    saveDraft: vi.fn(async (id: string, text: string, expected: number) => {
      const current = read(id)
      if (current.revision !== expected) return { applied: false, draft: current }
      const draft = { text, revision: expected + 1 }
      records.set(id, draft)
      return { applied: true, draft }
    }),
    sendText: vi.fn(async (id: string, text: string, _reply?: string, revision?: number): Promise<TextSent> => {
      const current = read(id)
      let consumedRevision: number | undefined
      if (current.revision === revision && current.text.trim() === text) {
        consumedRevision = current.revision + 1
        records.set(id, { text: '', revision: consumedRevision })
      }
      return { draft: read(id), consumedRevision }
    }),
  }
  const controller = new ConversationDrafts(core)
  return { records, read, core, controller }
}

describe('conversation draft coordinator', () => {
  it('deletion clears only the affected quote without saving or changing text generations', async () => {
    const { controller, core } = fixture('Keep this draft')
    await controller.load('chat')
    controller.reply('chat', { messageId: 'deleted', text: 'Original' })
    const before = controller.snapshot('chat')
    controller.forgetReply('chat', 'unrelated')
    expect(controller.snapshot('chat').quote).toEqual(before.quote)
    controller.forgetReply('chat', 'deleted')
    expect(controller.snapshot('chat')).toMatchObject({ text: before.text, generation: before.generation, quote: undefined })
    expect(core.saveDraft).not.toHaveBeenCalled()
    controller.reply('chat', { messageId: 'newer', text: 'New quote' })
    controller.forgetReply('chat', 'deleted')
    expect(controller.snapshot('chat').quote?.messageId).toBe('newer')
  })

  it('late failed send recovery cannot restore a deleted quote or overwrite newer typing', async () => {
    const { controller, core } = fixture('Submitted')
    await controller.load('chat')
    const pending = deferred<TextSent>()
    const started = deferred<void>()
    core.sendText.mockImplementationOnce(() => { started.resolve(); return pending.promise })
    controller.reply('chat', { messageId: 'deleted', text: 'Original' })
    const sending = controller.send('chat')
    await started.promise
    controller.edit('chat', 'New typing')
    controller.reply('chat', { messageId: 'newer', text: 'New quote' })
    controller.forgetReply('chat', 'deleted')
    pending.reject(new Error('Rejected send'))
    expect(await sending).toBe(false)
    expect(controller.snapshot('chat')).toMatchObject({ text: 'New typing', quote: { messageId: 'newer' } })
    expect(controller.snapshot('chat').failed[0]).toMatchObject({ text: 'Submitted', quote: undefined })
  })

  it('invalidates queued loads, saves, and sends when the account session changes', async () => {
    const { controller, core } = fixture()
    const load = deferred<Draft>()
    core.getDraft.mockImplementationOnce(() => load.promise)
    controller.load('chat')
    controller.edit('chat', 'Previous account text')
    const sending = controller.send('chat')
    controller.invalidate()
    load.resolve({ text: '', revision: 0 })
    expect(await sending).toBe(false)
    await controller.idle('chat')
    expect(core.saveDraft).not.toHaveBeenCalled()
    expect(core.sendText).not.toHaveBeenCalled()
  })

  it('does not continue queued writes after an in-flight save settles for an old account', async () => {
    const { controller, core } = fixture()
    const started = deferred<void>()
    const save = deferred<{ applied: boolean; draft: Draft }>()
    core.saveDraft.mockImplementationOnce(async () => { started.resolve(); return save.promise })
    controller.edit('chat', 'First old edit')
    await started.promise
    controller.edit('chat', 'Queued old edit')
    const sending = controller.send('chat')
    controller.invalidate()
    save.resolve({ applied: true, draft: { text: 'First old edit', revision: 1 } })
    expect(await sending).toBe(false)
    await controller.idle('chat')
    expect(core.saveDraft).toHaveBeenCalledTimes(1)
    expect(core.sendText).not.toHaveBeenCalled()
  })

  it('loads exact whitespace without saving or publishing a normal status', async () => {
    const { controller, core } = fixture('  local text\n')
    controller.load('chat')
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('  local text\n')
    expect(controller.snapshot('chat').issue).toBeUndefined()
    expect(core.saveDraft).not.toHaveBeenCalled()
  })

  it('keeps typing when an initial load completes late', async () => {
    const { controller, core, read } = fixture('Old draft')
    const load = deferred<Draft>()
    core.getDraft.mockImplementationOnce(() => load.promise)
    controller.load('chat')
    controller.edit('chat', 'New local typing')
    load.resolve({ text: 'Old draft', revision: 1 })
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('New local typing')
    expect(read('chat').text).toBe('New local typing')
  })

  it('waits for the initial restore before capturing an attachment caption', async () => {
    const { controller, core, read } = fixture('Stored caption')
    const load = deferred<Draft>()
    core.getDraft.mockImplementationOnce(() => load.promise)
    const capture = controller.captureCaption('chat')
    expect(core.saveDraft).not.toHaveBeenCalled()
    load.resolve({ text: 'Stored caption', revision: 1 })
    const captured = await capture
    expect(captured?.text).toBe('Stored caption')
    expect(await controller.sendCaption('chat', captured!, (revision) => core.sendText('chat', captured!.text, undefined, revision))).toBe(true)
    expect(core.sendText).toHaveBeenCalledWith('chat', 'Stored caption', undefined, expect.any(Number))
    expect(read('chat').text).toBe('')
  })

  it('keeps typing enabled while an attachment waits for the initial restore', async () => {
    const { controller, core, read } = fixture('Stored caption')
    const load = deferred<Draft>()
    core.getDraft.mockImplementationOnce(() => load.promise)
    const capture = controller.captureCaption('chat')
    controller.edit('chat', 'Typed during restore')
    load.resolve({ text: 'Stored caption', revision: 1 })
    const captured = await capture
    expect(captured?.text).toBe('Typed during restore')
    expect(await controller.sendCaption('chat', captured!, (revision) => core.sendText('chat', captured!.text, undefined, revision))).toBe(true)
    expect(core.sendText).toHaveBeenCalledWith('chat', 'Typed during restore', undefined, expect.any(Number))
    expect(read('chat').text).toBe('')
  })

  it('does not treat selecting a quote as replacing loaded text', async () => {
    const { controller } = fixture('Saved text')
    controller.load('chat')
    controller.reply('chat', { messageId: 'original', text: 'Quote' })
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('Saved text')
    expect(controller.snapshot('chat').quote?.messageId).toBe('original')
  })

  it('serializes identical and empty edits and retains separate chats', async () => {
    const { controller, read } = fixture()
    controller.edit('chat', 'Same')
    controller.edit('chat', 'Same')
    controller.edit('chat', '')
    controller.edit('other', 'Other draft')
    await Promise.all([controller.idle('chat'), controller.idle('other')])
    expect(read('chat')).toEqual({ text: '', revision: 3 })
    expect(read('other').text).toBe('Other draft')
  })

  it('keeps local text on save failure and retries explicitly', async () => {
    const { controller, core, read } = fixture()
    core.saveDraft.mockRejectedValueOnce(new Error('Disk unavailable'))
    controller.edit('chat', 'Keep this')
    await controller.idle('chat')
    controller.edit('chat', 'Newest text')
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('Newest text')
    expect(controller.snapshot('chat').issue?.message).toContain('Disk unavailable')
    expect(read('chat').text).toBe('')
    controller.retry('chat')
    await controller.idle('chat')
    expect(read('chat').text).toBe('Newest text')
    expect(controller.snapshot('chat').issue).toBeUndefined()
  })

  it('preserves text after a load failure and an edit before retry', async () => {
    const { controller, core, read } = fixture('Stored')
    core.getDraft.mockRejectedValueOnce(new Error('Cannot read'))
    controller.load('chat')
    await controller.idle('chat')
    controller.edit('chat', 'Typed during failure')
    await controller.idle('chat')
    controller.retry('chat')
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('Typed during failure')
    expect(read('chat').text).toBe('Typed during failure')
  })

  it('loads the existing draft on retry when no text edit occurred', async () => {
    const { controller, core } = fixture('Stored')
    core.getDraft.mockRejectedValueOnce(new Error('Cannot read'))
    controller.load('chat')
    await controller.idle('chat')
    controller.retry('chat')
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('Stored')
    expect(core.saveDraft).not.toHaveBeenCalled()
  })

  it('reports a conflict without replacing local text or silently retrying', async () => {
    const { controller, records, core, read } = fixture('Original')
    controller.load('chat')
    await controller.idle('chat')
    records.set('chat', { text: 'Changed elsewhere', revision: 5 })
    controller.edit('chat', 'Local edit')
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('Local edit')
    expect(controller.snapshot('chat').issue?.message).toContain('saved draft changed')
    expect(core.saveDraft).toHaveBeenCalledTimes(1)
    expect(read('chat').text).toBe('Changed elsewhere')
    controller.retry('chat')
    await controller.idle('chat')
    expect(read('chat')).toEqual({ text: 'Local edit', revision: 6 })
  })

  it('consumes accepted text but never clears newer identical text', async () => {
    const { controller, core, read } = fixture()
    const started = deferred<void>()
    const gate = deferred<void>()
    const accept = core.sendText.getMockImplementation()!
    core.sendText.mockImplementationOnce(async (...args) => { started.resolve(); await gate.promise; return accept(...args) })
    controller.edit('chat', ' identical ')
    const sending = controller.send('chat')
    await started.promise
    expect(controller.snapshot('chat').text).toBe('')
    controller.edit('chat', ' identical ')
    await controller.idle('chat')
    expect(read('chat').text).toBe(' identical ')
    gate.resolve()
    expect(await sending).toBe(true)
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe(' identical ')
    expect(read('chat').text).toBe(' identical ')
    expect(core.sendText).toHaveBeenCalledWith('chat', 'identical', undefined, expect.any(Number))
  })

  it('retains rejected-send recovery and pending saves without a subscribed conversation', async () => {
    const { controller, core, read } = fixture()
    const gate = deferred<void>()
    const started = deferred<void>()
    core.sendText.mockImplementationOnce(async () => { started.resolve(); await gate.promise; throw new Error('Send rejected') })
    const unsubscribe = controller.subscribe('chat', () => {})
    controller.edit('chat', 'Submitted')
    const sending = controller.send('chat')
    await started.promise
    unsubscribe()
    controller.edit('chat', 'Newer text')
    gate.reject(new Error('Send rejected'))
    expect(await sending).toBe(false)
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('Newer text')
    expect(read('chat').text).toBe('Newer text')
    expect(controller.snapshot('chat').failed[0].text).toBe('Submitted')
  })

  it('restores an untouched rejected send with its session-only quote', async () => {
    const { controller, core, read } = fixture()
    controller.edit('chat', '  Original draft  ')
    controller.reply('chat', { messageId: 'original', text: 'Quoted' })
    core.sendText.mockRejectedValueOnce(new Error('Send rejected'))
    expect(await controller.send('chat')).toBe(false)
    expect(controller.snapshot('chat').text).toBe('  Original draft  ')
    expect(controller.snapshot('chat').quote?.messageId).toBe('original')
    expect(read('chat').text).toBe('  Original draft  ')
  })

  it('does not restore an accepted send if its fallback draft read fails', async () => {
    const { controller, core } = fixture()
    controller.edit('chat', 'Accepted')
    await controller.idle('chat')
    core.sendText.mockResolvedValueOnce({})
    core.getDraft.mockRejectedValueOnce(new Error('Draft read failed'))
    expect(await controller.send('chat')).toBe(true)
    expect(controller.snapshot('chat').text).toBe('')
    expect(controller.snapshot('chat').failed).toEqual([])
    expect(controller.snapshot('chat').issue?.kind).toBe('load')
  })

  it('consumes an accepted caption durably without clearing equal newer text', async () => {
    const { controller, core, read } = fixture()
    const gate = deferred<void>()
    const started = deferred<void>()
    controller.edit('chat', 'Caption')
    const captured = controller.snapshot('chat')
    const accepting = controller.sendCaption('chat', captured, async (revision) => {
      started.resolve()
      await gate.promise
      return core.sendText('chat', captured.text.trim(), undefined, revision)
    })
    await started.promise
    controller.edit('chat', 'Caption')
    await controller.idle('chat')
    expect(read('chat').text).toBe('Caption')
    const beforeAcceptance = new ConversationDrafts(core)
    beforeAcceptance.load('chat')
    await beforeAcceptance.idle('chat')
    expect(beforeAcceptance.snapshot('chat').text).toBe('Caption')
    gate.resolve()
    expect(await accepting).toBe(true)
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('Caption')
    expect(read('chat').text).toBe('Caption')
    const restarted = new ConversationDrafts(core)
    restarted.load('chat')
    await restarted.idle('chat')
    expect(restarted.snapshot('chat').text).toBe('Caption')
  })

  it('saves new text during caption preparation and merges a delayed acceptance snapshot monotonically', async () => {
    const { controller, core, read } = fixture()
    const started = deferred<void>()
    const preparation = deferred<void>()
    const capturedAcceptance = deferred<void>()
    const response = deferred<void>()
    controller.edit('chat', 'Old caption')
    const captured = controller.snapshot('chat')
    const accepting = controller.sendCaption('chat', captured, async (revision) => {
      started.resolve()
      await preparation.promise
      const result = await core.sendText('chat', captured.text, undefined, revision)
      capturedAcceptance.resolve()
      await response.promise
      return result
    })
    await started.promise
    controller.edit('chat', 'New text before preparation ends')
    await controller.idle('chat')
    expect(read('chat').text).toBe('New text before preparation ends')
    const restarted = new ConversationDrafts(core)
    restarted.load('chat')
    await restarted.idle('chat')
    expect(restarted.snapshot('chat').text).toBe('New text before preparation ends')
    preparation.resolve()
    await capturedAcceptance.promise
    controller.edit('chat', 'New text before response arrives')
    await controller.idle('chat')
    expect(read('chat').text).toBe('New text before response arrives')
    response.resolve()
    expect(await accepting).toBe(true)
    controller.edit('chat', 'Next edit after stale acceptance')
    await controller.idle('chat')
    expect(read('chat').text).toBe('Next edit after stale acceptance')
    expect(controller.snapshot('chat').issue).toBeUndefined()
  })

  it('rebases a write only after confirming its CAS conflict is a local acceptance fence', async () => {
    const { controller, core, read } = fixture()
    const started = deferred<void>()
    const response = deferred<void>()
    const conflicted = deferred<void>()
    let accepted: TextSent | undefined
    controller.edit('chat', 'Old caption')
    await controller.idle('chat')
    const captured = controller.snapshot('chat')
    let captionRevision = 0
    const accepting = controller.sendCaption('chat', captured, async (revision) => {
      captionRevision = revision
      started.resolve()
      await response.promise
      return accepted!
    })
    await started.promise
    const save = core.saveDraft.getMockImplementation()!
    core.saveDraft.mockImplementationOnce(async (id, text, expected) => {
      accepted = await core.sendText('chat', captured.text, undefined, captionRevision)
      const result = await save(id, text, expected)
      expect(result.applied).toBe(false)
      conflicted.resolve()
      return result
    })
    controller.edit('chat', 'Newer durable text')
    await conflicted.promise
    expect(controller.snapshot('chat').text).toBe('Newer durable text')
    response.resolve()
    expect(await accepting).toBe(true)
    await controller.idle('chat')
    expect(read('chat').text).toBe('Newer durable text')
    expect(controller.snapshot('chat').issue).toBeUndefined()
  })

  it.each([undefined, 999])('requires explicit retry for an unrelated empty snapshot with absent or mismatched consumption evidence (%s)', async (unrelatedEvidence) => {
    const { controller, core, records, read } = fixture()
    const started = deferred<void>()
    const response = deferred<void>()
    const conflicted = deferred<void>()
    const accept = core.sendText.getMockImplementation()!
    let submittedRevision = 0
    core.sendText.mockImplementationOnce(async (...args) => {
      submittedRevision = args[3]!
      started.resolve()
      await response.promise
      const result = await accept(...args)
      return { ...result, consumedRevision: unrelatedEvidence }
    })
    controller.edit('chat', 'Pending submitted text')
    const sending = controller.send('chat')
    await started.promise
    records.set('chat', { text: '', revision: submittedRevision + 1 })
    const save = core.saveDraft.getMockImplementation()!
    core.saveDraft.mockImplementationOnce(async (...args) => {
      const result = await save(...args)
      expect(result.applied).toBe(false)
      conflicted.resolve()
      return result
    })
    const callsBeforeConflict = core.saveDraft.mock.calls.length
    controller.edit('chat', 'Keep this local edit')
    await conflicted.promise
    response.resolve()
    expect(await sending).toBe(true)
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('Keep this local edit')
    expect(controller.snapshot('chat').issue?.message).toContain('saved draft changed')
    expect(read('chat')).toEqual({ text: '', revision: submittedRevision + 1 })
    expect(core.saveDraft).toHaveBeenCalledTimes(callsBeforeConflict + 1)
    controller.retry('chat')
    await controller.idle('chat')
    expect(read('chat').text).toBe('Keep this local edit')
  })

  it('does not silently rebase an unrelated empty-draft CAS conflict', async () => {
    const { controller, records } = fixture('Existing')
    controller.load('chat')
    await controller.idle('chat')
    records.set('chat', { text: '', revision: 2 })
    controller.edit('chat', 'Local text')
    await controller.idle('chat')
    expect(controller.snapshot('chat').text).toBe('Local text')
    expect(controller.snapshot('chat').issue?.message).toContain('saved draft changed')
  })

  it('does not reload an already consumed caption after acceptance', async () => {
    const { controller, core } = fixture()
    controller.edit('chat', '  Caption  ')
    const captured = controller.snapshot('chat')
    expect(await controller.sendCaption('chat', captured, (revision) => core.sendText('chat', captured.text.trim(), undefined, revision))).toBe(true)
    expect(controller.snapshot('chat').text).toBe('')
    const restarted = new ConversationDrafts(core)
    restarted.load('chat')
    await restarted.idle('chat')
    expect(restarted.snapshot('chat').text).toBe('')
  })

})

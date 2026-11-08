import { describe, expect, it } from 'vitest'
import { CoreClient, type WorkerLike } from './client'
import type { CoreEvent, RequestEnvelope, ResponseEnvelope } from './protocol'

class FakeWorker implements WorkerLike {
  sent: RequestEnvelope[] = []
  private listener?: (event: MessageEvent<ResponseEnvelope>) => void
  postMessage(message: unknown) {
    this.sent.push(message as RequestEnvelope)
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent<ResponseEnvelope>) => void) {
    this.listener = listener
  }
  reply(data: ResponseEnvelope) {
    this.listener?.({ data } as MessageEvent<ResponseEnvelope>)
  }
}

describe('CoreClient', () => {
  it('matches responses to requests by id, in any order', async () => {
    const worker = new FakeWorker()
    const client = new CoreClient(worker)
    const status = client.status()
    const bench = client.bench(50)
    const [statusReq, benchReq] = worker.sent

    worker.reply({ id: benchReq.id, body: { type: 'bench', result: { members: 50, setupMs: 1, commitMs: 2, commitBytes: 3 } } })
    worker.reply({ id: statusReq.id, body: { type: 'status', status: { version: '0.1.0', selfTest: true } } })

    await expect(status).resolves.toEqual({ version: '0.1.0', selfTest: true })
    await expect(bench).resolves.toMatchObject({ members: 50 })
  })

  it('uses reference-only reply requests and boolean-only typing requests', async () => {
    const worker = new FakeWorker()
    const client = new CoreClient(worker)
    const sending = client.sendText('conversation', 'Reply body', '11'.repeat(16))
    const typing = client.setTyping('conversation', true)
    const disabling = client.setTypingIndicators(false)
    expect(worker.sent.map((e) => e.request)).toEqual([
      { type: 'sendText', conversationId: 'conversation', text: 'Reply body', replyTo: '11'.repeat(16) },
      { type: 'setTyping', conversationId: 'conversation', active: true },
      { type: 'setTypingIndicators', on: false },
    ])
    for (const { id, request } of worker.sent) worker.reply({ id, body: { type: request.type === 'sendText' ? 'textSent' : 'ok' } })
    await Promise.all([sending, typing, disabling])
    const initial = client.typing('conversation')
    const typists = [{ account: 'authenticated-account', name: 'Alex' }]
    worker.reply({ id: worker.sent.at(-1)!.id, body: { type: 'typing', typists } })
    await expect(initial).resolves.toEqual(typists)
    const seen: CoreEvent[] = []
    client.subscribe((event) => seen.push(event))
    worker.reply({ id: 0, event: { type: 'typing', conversationId: 'conversation', typists } })
    expect(seen).toEqual([{ type: 'typing', conversationId: 'conversation', typists }])
  })

  it('carries local draft revisions and returns save conflicts and send consumption', async () => {
    const worker = new FakeWorker()
    const client = new CoreClient(worker)
    const loading = client.getDraft('first')
    const saving = client.saveDraft('first', '  exact whitespace\n', 7)
    const sending = client.sendText('first', 'exact whitespace', undefined, 8)
    expect(worker.sent.map(({ request }) => request)).toEqual([
      { type: 'getDraft', conversationId: 'first' },
      { type: 'saveDraft', conversationId: 'first', text: '  exact whitespace\n', expectedRevision: 7 },
      { type: 'sendText', conversationId: 'first', text: 'exact whitespace', replyTo: undefined, draftRevision: 8 },
    ])
    worker.reply({ id: worker.sent[0].id, body: { type: 'draft', draft: { text: 'old', revision: 7 } } })
    worker.reply({ id: worker.sent[1].id, body: { type: 'draftSaved', applied: false, draft: { text: 'other', revision: 8 } } })
    worker.reply({ id: worker.sent[2].id, body: { type: 'textSent', draft: { text: '', revision: 9 }, consumedRevision: 9 } })
    await expect(loading).resolves.toEqual({ text: 'old', revision: 7 })
    await expect(saving).resolves.toEqual({ applied: false, draft: { text: 'other', revision: 8 } })
    await expect(sending).resolves.toEqual({ draft: { text: '', revision: 9 }, consumedRevision: 9 })
    const events: CoreEvent[] = []
    client.subscribe((event) => events.push(event))
    worker.reply({ id: 0, event: { type: 'draft', conversationId: 'first', draft: { text: '', revision: 9 } } })
    expect(events).toEqual([{ type: 'draft', conversationId: 'first', draft: { text: '', revision: 9 } }])
  })

  it('carries a caption revision without changing the existing media argument', async () => {
    const worker = new FakeWorker()
    const client = new CoreClient(worker)
    const file = new File(['body'], 'note.txt')
    const sending = client.sendFile('conversation', file, 'caption', { durationMs: 1000 }, 3)
    expect(worker.sent[0].request).toEqual({ type: 'sendFile', conversationId: 'conversation', file, caption: 'caption', media: { durationMs: 1000 }, draftRevision: 3 })
    worker.reply({ id: worker.sent[0].id, body: { type: 'fileSent', draft: { text: '', revision: 4 }, consumedRevision: 4 } })
    await expect(sending).resolves.toEqual({ draft: { text: '', revision: 4 }, consumedRevision: 4 })
    const legacy = client.sendFile('conversation', file, '')
    worker.reply({ id: worker.sent[1].id, body: { type: 'fileSent' } })
    await expect(legacy).resolves.toEqual({})
  })

  it.each(['text', 'file'] as const)('does not infer consumption from an empty %s response snapshot', async (kind) => {
    const worker = new FakeWorker()
    const client = new CoreClient(worker)
    const sending = kind === 'text'
      ? client.sendText('conversation', 'caption', undefined, 1)
      : client.sendFile('conversation', new File(['body'], 'note.txt'), 'caption', undefined, 1)
    worker.reply({ id: worker.sent[0].id, body: { type: kind === 'text' ? 'textSent' : 'fileSent', draft: { text: '', revision: 2 } } })
    await expect(sending).resolves.toEqual({ draft: { text: '', revision: 2 } })
  })

  it('requests storage usage through the worker and supports unlimited quotas', async () => {
    const worker = new FakeWorker()
    const client = new CoreClient(worker)
    const loading = client.storageUsage()
    expect(worker.sent[0].request).toEqual({ type: 'storageUsage' })
    const usage = { usedBytes: 12, reservedBytes: 3, limitBytes: null }
    worker.reply({ id: worker.sent[0].id, body: { type: 'storageUsage', usage } })
    await expect(loading).resolves.toEqual(usage)
    const failing = client.storageUsage()
    worker.reply({ id: worker.sent[1].id, body: { type: 'error', message: 'Storage unavailable' } })
    await expect(failing).rejects.toThrow('Storage unavailable')
  })

  it('rejects with the worker error message', async () => {
    const worker = new FakeWorker()
    const client = new CoreClient(worker)
    const status = client.status()
    worker.reply({ id: worker.sent[0].id, body: { type: 'error', message: 'boom' } })
    await expect(status).rejects.toThrow('boom')
  })

  it('delivers pushed events to subscribers', () => {
    const worker = new FakeWorker()
    const client = new CoreClient(worker)
    const seen: CoreEvent[] = []
    const unsubscribe = client.subscribe((e) => seen.push(e))
    worker.reply({ id: 0, event: { type: 'messages', conversationId: 'abc' } })
    unsubscribe()
    worker.reply({ id: 0, event: { type: 'messages', conversationId: 'def' } })
    expect(seen).toEqual([{ type: 'messages', conversationId: 'abc' }])
  })
})

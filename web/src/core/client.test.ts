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
    for (const { id } of worker.sent) worker.reply({ id, body: { type: 'ok' } })
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

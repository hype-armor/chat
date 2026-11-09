import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import { makeIdentity } from './ids'
import type { ChatMessage } from './protocol'
import * as transfers from './transfers'

const account = '11'.repeat(16)
const device = '22'.repeat(16)
const peer = '33'.repeat(16)
const peerDevice = '44'.repeat(16)
const conversationId = '55'.repeat(16)
const messageId = '66'.repeat(16)
const file = { name: 'big.bin', mime: 'application/octet-stream', size: 20 * 1024 * 1024, key: '', digest: '' }

function setup() {
  const values = new Map<string, unknown>()
  values.set(`messages:${conversationId}`, [{
    id: messageId, from: 'me', text: '', sentAt: 1, status: 'failed', error: 'Interrupted upload', file,
  }])
  const reads: Promise<ChatMessage[]>[] = []
  let readOnStatus = false
  const engine = new Engine((event) => {
    if (readOnStatus && event.type === 'messages' && event.conversationId === conversationId) {
      // The UI refreshes history after a status event. Queue that read before
      // retryMessage can start its background uploader.
      readOnStatus = false
      reads.push(engine.messages(conversationId))
    }
  })
  engine['account'] = { accountId: account, deviceId: device, username: 'me', displayName: 'Me', token: 'synthetic-token' }
  engine['core'] = {
    identity: () => makeIdentity(account, device),
    members: () => [makeIdentity(account, device), makeIdentity(peer, peerDevice)],
    snapshot: () => new Uint8Array([1]),
  } as unknown as NonNullable<Engine['core']>
  engine['state'].conversations[conversationId] = { id: conversationId, peers: [peer], lastAt: 1 }
  engine['store'] = {
    getJson: vi.fn(async (key: string) => structuredClone(values.get(key))),
    putJson: vi.fn(async (key: string, value: unknown) => { values.set(key, structuredClone(value)) }),
    putBytes: vi.fn(async () => {}),
    getFile: vi.fn(async () => new Blob(['synthetic sealed body'])),
  } as unknown as Engine['store']
  engine['connection'] = 'online'
  engine['flushOutbox'] = vi.fn(async () => {})
  engine['encode'] = vi.fn(() => new Uint8Array([2]))
  const upload = vi.spyOn(transfers, 'upload').mockResolvedValue('77777777-7777-7777-7777-777777777777')
  const realUploadAndSend = engine['uploadAndSend'].bind(engine)
  const uploadRuns: Promise<void>[] = []
  engine['uploadAndSend'] = (conversation, message) => {
    const run = realUploadAndSend(conversation, message)
    uploadRuns.push(run)
    return run
  }
  return {
    engine, values, reads, upload,
    readNextStatus: () => { readOnStatus = true },
    finishUpload: async () => {
      // Include every resume invocation, even an immediate inflight return.
      await Promise.all(uploadRuns)
      await engine['lock']
    },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('upload retry acceptance', () => {
  it('reserves the retry before a status-triggered history read can classify it as unaccepted', async () => {
    const { engine, reads, upload, readNextStatus, finishUpload } = setup()
    readNextStatus()
    await engine.retryMessage(conversationId, messageId)
    await finishUpload()
    expect(reads).toHaveLength(1)
    expect((await reads[0])[0].status).toBe('sending')
    expect(upload).toHaveBeenCalledOnce()
    expect(engine['state'].outbox).toHaveLength(1)
    expect(engine['state'].outbox[0].messageId).toBe(messageId)
    expect(engine['state'].transfers).toEqual([])
    expect((await engine.messages(conversationId))[0]).toMatchObject({ status: 'sending', error: undefined })
  })

  it('does not let reconnect cleanup remove a retry reservation between persistence and sending', async () => {
    const { engine, reads, upload, readNextStatus, finishUpload } = setup()
    const putJson = engine['store'].putJson.bind(engine['store'])
    let reconnect: Promise<void> | undefined
    engine['store'].putJson = async (key, value) => {
      await putJson(key, value)
      if (key === 'app' && !reconnect && engine['state'].transfers.some((transfer) => transfer.messageId === messageId)) {
        // Reconnect resumes transfers after its queued commit-resolution lock.
        // Put that task behind reservation persistence, before any second lock
        // that retryMessage uses to publish sending.
        reconnect = engine['exclusive'](async () => {}).then(() => engine['resumeTransfers']())
      }
    }
    readNextStatus()
    await engine.retryMessage(conversationId, messageId)
    await reconnect
    await finishUpload()
    expect(reconnect).toBeDefined()
    expect(reads).toHaveLength(1)
    expect((await reads[0])[0].status).toBe('sending')
    expect(upload).toHaveBeenCalledOnce()
    expect(engine['state'].outbox).toHaveLength(1)
    expect(engine['state'].outbox[0].messageId).toBe(messageId)
    expect((await engine.messages(conversationId))[0]).toMatchObject({ status: 'sending', error: undefined })
  })

  it('persists the upload reservation before publishing sending or starting network I/O', async () => {
    const { engine, values, upload } = setup()
    const snapshots: unknown[] = []
    const setStatus = engine['setStatus'].bind(engine)
    engine['setStatus'] = async (...args) => {
      if (args[2] === 'sending') snapshots.push(structuredClone(values.get('app')))
      return setStatus(...args)
    }
    const uploadAndSend = engine['uploadAndSend']
    engine['uploadAndSend'] = vi.fn(async () => {})
    await engine.retryMessage(conversationId, messageId)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ transfers: [{ conversationId, messageId, kind: 'upload' }] })
    expect(upload).not.toHaveBeenCalled()
    engine['uploadAndSend'] = uploadAndSend
  })
})

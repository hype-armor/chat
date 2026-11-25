// Copy into web/src/core at the pinned pre-topic revision. See docs/testing-topic-legacy-wasm.md.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeAll, expect, it, vi } from 'vitest'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'
import { Engine } from './engine'
import { RecentIds, makeIdentity, randomId, toHex } from './ids'
import { OLD_COMMIT, loadPackage } from '../../../scripts/test-topic-legacy-wasm.mjs'

const CURRENT_CI_COMMIT = '4e018ad818288cb32df9c35c77ea78f48004bad8'
let senderPackage: Awaited<ReturnType<typeof loadPackage>>

beforeAll(async () => {
  const current = process.env.CURRENT_TOPIC_WASM_PACKAGE
  if (!current) throw new Error('Set CURRENT_TOPIC_WASM_PACKAGE to the verified current CI package')
  const read = (name: string) => readFileSync(new URL(`./pkg/${name}`, import.meta.url))
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const manifest = JSON.parse(read('topic-compat-build.json').toString('utf8'))
  const wasm = read('chat_core_bg.wasm')
  expect(manifest.sourceCommit).toBe(OLD_COMMIT)
  expect(sha(wasm)).toBe(manifest.wasmSha256)
  expect(sha(read('chat_core.js'))).toBe(manifest.jsSha256)
  initSync({ module: wasm })
  expect(CoreClient.prototype).not.toHaveProperty('sendGroupTopic')
  senderPackage = await loadPackage(current, 'current-for-legacy-engine', CURRENT_CI_COMMIT)
})

function setup() {
  const current = senderPackage.module
  const alice = new current.PendingClient().intoClient(makeIdentity('11'.repeat(16), '22'.repeat(16)))
  const bob = new PendingClient().intoClient(makeIdentity('33'.repeat(16), '44'.repeat(16)))
  const started = alice.startConversation([bob.identity()], bob.keyPackages(1), randomId())
  bob.receive(started.welcome)
  const id = toHex(started.conversationId)
  const baseline = new Engine(() => {})
  baseline['state'].conversations[id] = { id, peers: ['11'.repeat(16)], lastAt: 1 }
  const values = new Map<string, unknown>([['core', bob.snapshot()], ['app', structuredClone(baseline['state'])]])
  const order: string[] = []
  const emit = vi.fn()
  let rejectApp = false
  const store = {
    putBytes: async (key: string, bytes: Uint8Array) => { values.set(key, bytes.slice()); order.push(key) },
    putJson: async (key: string, value: unknown) => {
      if (key === 'app' && rejectApp) throw new Error('injected app write failure')
      values.set(key, structuredClone(value))
      order.push(key)
    },
    getJson: async (key: string) => values.get(key),
  } as unknown as Engine['store']
  const fresh = () => {
    const engine = new Engine(emit)
    engine['core'] = CoreClient.restore(values.get('core') as Uint8Array)
    engine['state'] = structuredClone(values.get('app')) as Engine['state']
    engine['recent'] = new RecentIds(engine['state'].seen)
    engine['account'] = { accountId: '33'.repeat(16), deviceId: '44'.repeat(16), username: 'bob', displayName: 'Bob', token: '' }
    engine['store'] = store
    engine['ws'] = { send: () => { order.push('ack') } } as unknown as Engine['ws']
    engine['flushOutbox'] = vi.fn(async () => {})
    return engine
  }
  const frame = {
    conversationId: started.conversationId,
    messageId: randomId(),
    envelope: alice.sendGroupTopic(started.conversationId, 'private cross-version topic', 1, 10, randomId()),
    welcome: false,
  } as Parameters<Engine['onDeliver']>[0]
  const verifySaved = () => {
    expect(emit).not.toHaveBeenCalled()
    expect(values.has('messages:' + id)).toBe(false)
    expect(JSON.stringify(values.get('app'))).not.toContain('private cross-version topic')
    expect((values.get('app') as Engine['state']).seen).toContain(toHex(frame.messageId))
    const restored = CoreClient.restore(values.get('core') as Uint8Array)
    expect(() => restored.receive(frame.envelope)).toThrow()
    const after = restored.receive(alice.sendText(frame.conversationId, 'after topic', 11, randomId()))
    expect(after.text).toBe('after topic')
    expect(after.sender).toEqual(alice.identity())
  }
  return { fresh, frame, order, verifySaved, rejectApp: (reject: boolean) => { rejectApp = reject } }
}

it('old delivery saves the ignored topic ratchet before acknowledgement', async () => {
  const { fresh, frame, order, verifySaved } = setup()
  await fresh()['onDeliver'](frame)
  expect(order).toEqual(['core', 'app', 'ack'])
  verifySaved()
})

it('old delivery can acknowledge a replay after restart between core and app writes', async () => {
  const { fresh, frame, order, verifySaved, rejectApp } = setup()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    rejectApp(true)
    await expect(fresh()['onDeliver'](frame)).rejects.toThrow('injected app write failure')
    expect(order).toEqual(['core'])
    order.length = 0
    rejectApp(false)
    await fresh()['onDeliver'](frame)
    expect(warn).toHaveBeenCalledWith('dropping envelope that could not be processed', expect.any(Error))
    expect(order).toEqual(['core', 'app', 'ack'])
    verifySaved()
  } finally {
    warn.mockRestore()
  }
})

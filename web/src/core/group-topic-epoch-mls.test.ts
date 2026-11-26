/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'
import { applyGroupTopic, applyGroupTopicSnapshot, nextGroupTopicClock, type GroupTopic } from './groupTopic'
import { makeIdentity, randomId, toHex } from './ids'

beforeAll(() => initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) }))

function pair() {
  const a = makeIdentity('11'.repeat(16), '22'.repeat(16))
  const b = makeIdentity('33'.repeat(16), '44'.repeat(16))
  const alice = new PendingClient().intoClient(a)
  const bob = new PendingClient().intoClient(b)
  const started = alice.startConversation([b], bob.keyPackages(1), randomId())
  bob.receive(started.welcome)
  return { alice, bob, id: started.conversationId, a, b }
}

// This adapter models the intended reducer input, not the disabled worker path.
function reduce(current: GroupTopic | undefined, event: ReturnType<CoreClient['receive']>) {
  const sender = event.sender!
  return applyGroupTopic(current, { text: event.groupTopicText, clock: event.groupTopicClock }, {
    account: toHex(sender.slice(0, 16)), device: toHex(sender.slice(16)),
  })
}

describe('group topic MLS foundations', () => {
  it('orders concurrent authenticated updates independently of arrival order', () => {
    const { alice, bob, id, a, b } = pair()
    const fromAlice = alice.sendGroupTopic(id, 'alice', 1, 1, randomId())
    const fromBob = bob.sendGroupTopic(id, 'bob', 1, 1, randomId())
    const atBob = bob.receive(fromAlice)
    const atAlice = alice.receive(fromBob)
    expect(atBob.sender).toEqual(a)
    expect(atAlice.sender).toEqual(b)
    expect(atBob.conversationId).toEqual(id)
    const aState = applyGroupTopic(undefined, { text: 'alice', clock: 1 }, { account: toHex(a.slice(0, 16)), device: toHex(a.slice(16)) })
    const bState = applyGroupTopic(undefined, { text: 'bob', clock: 1 }, { account: toHex(b.slice(0, 16)), device: toHex(b.slice(16)) })
    expect(reduce(aState, atAlice)).toEqual(reduce(bState, atBob))
    expect(reduce(aState, atAlice)?.text).toBe('bob')
  })

  it('keeps the clock across membership changes and leaves the newcomer unknown without a snapshot', () => {
    const { alice, bob, id } = pair()
    const before = reduce(undefined, bob.receive(alice.sendGroupTopic(id, '', 5, 1, randomId())))!
    const newcomerIdentity = makeIdentity('55'.repeat(16), '66'.repeat(16))
    const newcomer = new PendingClient().intoClient(newcomerIdentity)
    const added = alice.addMembers(id, [newcomerIdentity], newcomer.keyPackages(1), randomId(), randomId())
    alice.confirmCommit(id)
    bob.receive(added.commit)
    newcomer.receive(added.welcome)
    let newcomerState: GroupTopic | undefined
    expect(newcomerState).toBeUndefined()
    // This is only a pure attestation merge. No snapshot transport exists yet.
    newcomerState = applyGroupTopicSnapshot(newcomerState, before)
    expect(newcomerState).toEqual(before)
    expect(nextGroupTopicClock(newcomerState)).toBe(6)
    const update = alice.sendGroupTopic(id, 'new epoch', 6, 2, randomId())
    expect(reduce(before, bob.receive(update))).toEqual(reduce(newcomerState, newcomer.receive(update)))
    const removed = alice.removeMembers(id, [newcomerIdentity.slice(0, 16)], randomId())
    alice.confirmCommit(id)
    bob.receive(removed.commit)
    const afterRemoval = alice.sendGroupTopic(id, 'after removal', 7, 3, randomId())
    expect(reduce(before, bob.receive(afterRemoval))?.clock).toBe(7)
    expect(() => newcomer.receive(afterRemoval)).toThrow()
  })

  it('restores an MLS ratchet after a topic and decrypts a later topic', () => {
    const { alice, bob, id } = pair()
    const state = reduce(undefined, bob.receive(alice.sendGroupTopic(id, 'first', 1, 1, randomId())))!
    const restored = CoreClient.restore(bob.snapshot())
    const later = restored.receive(alice.sendGroupTopic(id, '', 2, 2, randomId()))
    expect(reduce(state, later)).toMatchObject({ text: '', clock: 2 })
    // The MLS snapshot does not itself persist the application topic state.
    expect(reduce(undefined, later)?.clock).toBe(2)
  })
})

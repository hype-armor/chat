/// <reference types="node" />
// Profile pictures through the real core: an MLS conversation between two
// clients, with the picture carried inside the encrypted `Profile` message.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { CoreClient, PendingClient, initSync } from './pkg/chat_core.js'
import { makeIdentity, randomId } from './ids'

beforeAll(() => {
  initSync({ module: readFileSync(new URL('./pkg/chat_core_bg.wasm', import.meta.url)) })
})

describe('profile pictures over MLS', () => {
  const photo = new Uint8Array(4096)
  photo.set([0xff, 0xd8, 0xff, 0xe0])
  photo.fill(7, 4)

  function pair(): { alice: CoreClient; bob: CoreClient; conversationId: Uint8Array } {
    const alice = new PendingClient().intoClient(makeIdentity('11'.repeat(16), '22'.repeat(16)))
    const bob = new PendingClient().intoClient(makeIdentity('33'.repeat(16), '44'.repeat(16)))
    const started = alice.startConversation([makeIdentity('33'.repeat(16), '44'.repeat(16))], bob.keyPackages(1), randomId())
    expect(bob.receive(started.welcome).kind).toBe('joined')
    return { alice, bob, conversationId: started.conversationId }
  }

  it('delivers the sender’s picture with the name', () => {
    const { alice, bob, conversationId } = pair()
    const event = bob.receive(alice.sendProfile(conversationId, 'Alice', photo, Date.now(), randomId()))
    expect(event.kind).toBe('message')
    expect(event.displayName).toBe('Alice')
    expect(event.avatar).toEqual(photo)
  })

  it('reports no picture when the profile carries none', () => {
    const { alice, bob, conversationId } = pair()
    const event = bob.receive(alice.sendProfile(conversationId, 'Alice', new Uint8Array(), Date.now(), randomId()))
    expect(event.displayName).toBe('Alice')
    expect(event.avatar).toBeUndefined()
  })
})

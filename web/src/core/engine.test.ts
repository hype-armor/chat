import { describe, expect, it } from 'vitest'
import { Engine } from './engine'
import { fromHex, makeIdentity } from './ids'

const account = '11'.repeat(16)
const device = '22'.repeat(16)
const otherDevice = '33'.repeat(16)
const peer = '44'.repeat(16)
const peerDevice = '55'.repeat(16)
const conversationId = '66'.repeat(16)
const me = makeIdentity(account, device)
const sender = makeIdentity(peer, peerDevice)

function engineWithMembers() {
  const engine = new Engine(() => {})
  engine['core'] = {
    identity: () => me,
    members: () => [me, makeIdentity(account, otherDevice), sender, new Uint8Array(31)],
  } as unknown as NonNullable<Engine['core']>
  return engine
}

describe('engine routing and group metadata', () => {
  it('excludes only this device, not the account’s other devices, from recipients', () => {
    const engine = engineWithMembers()
    expect(engine['recipients'](conversationId)).toEqual([otherDevice, peerDevice])
  })

  it('learns a two-person group’s name and admins from its first GroupInfo', async () => {
    const engine = engineWithMembers()
    const conv = { id: conversationId, peers: [peer], lastAt: 0 }
    engine['state'].conversations[conversationId] = conv
    await engine['apply']({
      kind: 'message',
      conversationId: fromHex(conversationId),
      sender,
      groupName: 'Message polish',
      groupAdmins: fromHex(peer),
    } as Parameters<Engine['apply']>[0], '77'.repeat(16))
    expect(conv).toMatchObject({ name: 'Message polish', admins: [peer] })
  })

  it.each(['non-admin', 'removed'] as const)('rejects GroupInfo for a %s', async (reason) => {
    const engine = engineWithMembers()
    const conv = {
      id: conversationId,
      peers: [peer],
      name: 'Original',
      admins: [reason === 'non-admin' ? account : peer],
      status: reason === 'removed' ? 'removed' as const : undefined,
      lastAt: 0,
    }
    engine['state'].conversations[conversationId] = conv
    await engine['apply']({
      kind: 'message',
      conversationId: fromHex(conversationId),
      sender,
      groupName: 'Changed',
      groupAdmins: fromHex(peer),
    } as Parameters<Engine['apply']>[0], '77'.repeat(16))
    expect(conv.name).toBe('Original')
  })
})

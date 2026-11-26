import { describe, expect, it } from 'vitest'
import { makeIdentity } from './ids'
import { acceptsRestrictedChannelInfo, authenticatedChannelRoster, restrictedInviteRoster, revokedRestrictedChannelDevices } from './restrictedChannelRoster'

const account = (n: string) => n.repeat(16)
const member = (a: string, d: string) => ({ account: account(a), device: account(d) })
const alice = member('11', 'aa'), bob = member('22', 'bb'), tablet = member('22', 'bc'), cathy = member('33', 'cc')
const parent = [alice, bob, tablet, cathy]

describe('restricted channel authenticated membership', () => {
  it('decodes exact MLS identities, rejecting malformed identities and reused device IDs', () => {
    const ids = parent.map(({ account, device }) => makeIdentity(account, device))
    expect(authenticatedChannelRoster(ids)).toEqual(parent)
    expect(authenticatedChannelRoster([...ids, new Uint8Array(31)])).toBeUndefined()
    expect(authenticatedChannelRoster([...ids, makeIdentity(cathy.account, bob.device)])).toBeUndefined()
  })

  it('selects all and only eligible parent devices and refuses outsiders', () => {
    expect(restrictedInviteRoster(parent, [bob.account])).toEqual([bob, tablet])
    expect(restrictedInviteRoster(parent, [bob.account, account('ff')])).toBeUndefined()
    expect(restrictedInviteRoster(parent, [bob.account, bob.account])).toBeUndefined()
  })

  it('revokes all former account devices and does not let a parent rejoin cancel revocation', () => {
    const child = [alice, bob, tablet]
    const revoked = revokedRestrictedChannelDevices([alice, cathy], child)
    expect(revoked).toEqual([bob, tablet])
    expect(revokedRestrictedChannelDevices(parent, child, revoked.map(({ device }) => device))).toEqual(revoked)
    expect(revokedRestrictedChannelDevices(parent, [alice], revoked.map(({ device }) => device))).toEqual([])
  })

  it('revokes a stale device without revoking other devices of that account', () => {
    expect(revokedRestrictedChannelDevices([alice, tablet, cathy], [alice, bob, tablet])).toEqual([bob])
    expect(revokedRestrictedChannelDevices([alice, { ...cathy, device: bob.device }], [alice, bob])).toEqual([bob])
  })

  it('checks the exact current parent admin device, recipient, and complete invited roster', () => {
    const binding = { parentConversation: account('44'), channelConversation: account('55'), parentDevices: parent,
      channelDevices: [alice, bob, tablet], parentAdmins: [alice.account], sender: alice, self: bob, parentStable: true }
    expect(acceptsRestrictedChannelInfo(binding)).toBe(true)
    expect(acceptsRestrictedChannelInfo({ ...binding, parentStable: false })).toBe(false)
    expect(acceptsRestrictedChannelInfo({ ...binding, sender: { ...alice, device: account('ff') } })).toBe(false)
    expect(acceptsRestrictedChannelInfo({ ...binding, sender: bob })).toBe(false)
    expect(acceptsRestrictedChannelInfo({ ...binding, self: cathy })).toBe(false)
    expect(acceptsRestrictedChannelInfo({ ...binding, channelDevices: [alice, bob] })).toBe(false)
    expect(acceptsRestrictedChannelInfo({ ...binding, parentDevices: [alice, cathy] })).toBe(false)
    expect(acceptsRestrictedChannelInfo({ ...binding, channelConversation: binding.parentConversation })).toBe(false)
  })
})

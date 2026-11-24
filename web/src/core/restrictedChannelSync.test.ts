import { describe, expect, it } from 'vitest'
import { planRestrictedChannelSync } from './restrictedChannelSync'
import type { RestrictedChannelSendSnapshot } from './restrictedChannel'

function snapshot(): RestrictedChannelSendSnapshot {
  return {
    parentConversation: 'parent', channelConversation: 'channel', parentEpoch: '1', channelEpoch: '2',
    removalsSynchronized: true,
    parentDevices: [{ account: 'alice', device: 'a1' }, { account: 'alice', device: 'a2' }, { account: 'bob', device: 'b1' }],
    invitedAccounts: ['alice'], channelDevices: [{ account: 'alice', device: 'a1' }],
  }
}

describe('restricted channel sync planning', () => {
  it('plans all invited parent devices without adding nonmembers', () => {
    expect(planRestrictedChannelSync(snapshot())).toEqual({ status: 'pending', add: [{ account: 'alice', device: 'a2' }], remove: [] })
  })

  it('plans removal of former devices and accounts', () => {
    const s = snapshot()
    s.channelDevices = [...s.channelDevices, { account: 'alice', device: 'old' }, { account: 'bob', device: 'b1' }]
    expect(planRestrictedChannelSync(s)).toEqual({ status: 'pending', add: [{ account: 'alice', device: 'a2' }], remove: [{ account: 'alice', device: 'old' }, { account: 'bob', device: 'b1' }] })
  })

  it('does not mark an exact roster synchronized while the removal barrier is unresolved', () => {
    const s = snapshot()
    s.channelDevices = s.parentDevices.filter(d => d.account === 'alice')
    expect(planRestrictedChannelSync({ ...s, removalsSynchronized: false })).toEqual({ status: 'pending', add: [], remove: [] })
    expect(planRestrictedChannelSync(s)).toEqual({ status: 'synchronized', add: [], remove: [] })
  })

  it('rejects incomplete, ambiguous, and duplicate snapshots', () => {
    const s = snapshot()
    for (const change of [
      { parentEpoch: '' }, { channelConversation: 'parent' }, { parentDevices: [] }, { channelDevices: [] },
      { invitedAccounts: ['alice', 'former'] }, { invitedAccounts: ['alice', 'alice'] },
      { parentDevices: [...s.parentDevices, s.parentDevices[0]] },
      { channelDevices: [...s.channelDevices, s.channelDevices[0]] },
      { channelDevices: [{ account: '', device: 'x' }] },
    ]) expect(planRestrictedChannelSync({ ...s, ...change })).toEqual({ status: 'invalid' })
  })

  it('treats identities as pairs, not delimiter-joined strings', () => {
    const s = snapshot()
    s.parentDevices = [{ account: 'a:b', device: 'c' }]
    s.invitedAccounts = ['a:b']
    s.channelDevices = [{ account: 'a', device: 'b:c' }]
    expect(planRestrictedChannelSync(s)).toEqual({ status: 'pending', add: [{ account: 'a:b', device: 'c' }], remove: [{ account: 'a', device: 'b:c' }] })
  })
})

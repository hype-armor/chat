import { describe, expect, it } from 'vitest'
import { canSendRestrictedChannel, type RestrictedChannelSendSnapshot } from './restrictedChannel'

function snapshot(): RestrictedChannelSendSnapshot {
  return {
    parentConversation: 'parent', channelConversation: 'channel', parentEpoch: '1', channelEpoch: '2',
    removalsSynchronized: true,
    parentDevices: [{ account: 'alice', device: 'a1' }, { account: 'alice', device: 'a2' }, { account: 'bob', device: 'b1' }],
    invitedAccounts: ['alice'],
    channelDevices: [{ account: 'alice', device: 'a1' }, { account: 'alice', device: 'a2' }],
  }
}

describe('restricted channel send gate', () => {
  it('allows an exact invited roster without requiring nonmembers', () => {
    expect(canSendRestrictedChannel(snapshot())).toBe(true)
  })

  it('blocks unresolved parent removals and missing snapshot identifiers', () => {
    for (const change of [
      { removalsSynchronized: false }, { parentEpoch: '' }, { channelEpoch: '' },
      { parentConversation: '' }, { channelConversation: 'parent' },
    ]) expect(canSendRestrictedChannel({ ...snapshot(), ...change })).toBe(false)
  })

  it('blocks former members and devices until the channel roster is updated', () => {
    const s = snapshot()
    expect(canSendRestrictedChannel({ ...s, parentDevices: s.parentDevices.filter(d => d.device !== 'a2') })).toBe(false)
    expect(canSendRestrictedChannel({ ...s, invitedAccounts: ['alice', 'bob'] })).toBe(false)
    expect(canSendRestrictedChannel({ ...s, channelDevices: [...s.channelDevices, { account: 'bob', device: 'b1' }] })).toBe(false)
    expect(canSendRestrictedChannel({ ...s, invitedAccounts: ['alice', 'former'] })).toBe(false)
  })

  it('blocks incomplete additions and duplicate or empty identities', () => {
    const s = snapshot()
    expect(canSendRestrictedChannel({ ...s, channelDevices: [s.channelDevices[0]] })).toBe(false)
    expect(canSendRestrictedChannel({ ...s, channelDevices: [...s.channelDevices, s.channelDevices[0]] })).toBe(false)
    expect(canSendRestrictedChannel({ ...s, parentDevices: [...s.parentDevices, s.parentDevices[0]] })).toBe(false)
    expect(canSendRestrictedChannel({ ...s, invitedAccounts: ['alice', 'alice'] })).toBe(false)
    expect(canSendRestrictedChannel({ ...s, parentDevices: [] })).toBe(false)
    expect(canSendRestrictedChannel({ ...s, channelDevices: [{ account: '', device: 'a1' }] })).toBe(false)
  })

  it('does not confuse opaque identifiers containing separators', () => {
    const s = snapshot()
    s.parentDevices = [{ account: 'a:b', device: 'c' }]
    s.invitedAccounts = ['a:b']
    s.channelDevices = [{ account: 'a', device: 'b:c' }]
    expect(canSendRestrictedChannel(s)).toBe(false)
  })
})

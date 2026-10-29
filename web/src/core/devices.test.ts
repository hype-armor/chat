import { describe, expect, it } from 'vitest'
import { deviceHex, linkText, memberDevicePlan, parseDeviceSync, parseLinkCode } from './devices'

const code = 'AAECAwQFBgcICQoLDA0ODw'

describe('link codes', () => {
  it('round-trips through the QR text and accepts typed codes', () => {
    expect(parseLinkCode(linkText(code))).toBe(code)
    expect(parseLinkCode(`  ${code} `)).toBe(code)
    expect(parseLinkCode('chat-link:v1:short')).toBeUndefined()
    expect(parseLinkCode('https://example.com')).toBeUndefined()
  })
  it('normalises device ids', () => {
    expect(deviceHex('0F0E0D0C-0B0A-0908-0706-050403020100')).toBe('0f0e0d0c0b0a09080706050403020100')
  })
})

describe('memberDevicePlan', () => {
  const members = [
    { account: 'bob', device: 'b1' },
    { account: 'me', device: 'd1' },
    { account: 'me', device: 'd2' },
  ]
  it('an account keeps its own devices: only its lowest live leaf acts', () => {
    const live = { me: ['d1', 'd2', 'd3'], bob: ['b1'] }
    expect(memberDevicePlan(members, live, 'd2')).toEqual([])
    expect(memberDevicePlan(members, live, 'd1')).toEqual([{ account: 'me', missing: ['d3'], stale: [] }])
  })
  it('removes devices that no longer exist', () => {
    expect(memberDevicePlan(members, { me: ['d1'], bob: ['b1'] }, 'd1')).toEqual([
      { account: 'me', missing: [], stale: ['d2'] },
    ])
  })
  it('a restored account is handled by the group: new device added, lost ones removed', () => {
    // Bob restored onto b9; b1 is gone. The group's lowest live leaf (d1) acts.
    const live = { me: ['d1', 'd2'], bob: ['b9'] }
    expect(memberDevicePlan(members, live, 'd1')).toEqual([{ account: 'bob', missing: ['b9'], stale: ['b1'] }])
    expect(memberDevicePlan(members, live, 'd2')).toEqual([])
  })
  it('a deleted account has its leaves removed', () => {
    expect(memberDevicePlan(members, { me: ['d1', 'd2'] }, 'd1')).toEqual([{ account: 'bob', missing: [], stale: ['b1'] }])
  })
  it("doesn't act for a contact who can act themselves", () => {
    expect(memberDevicePlan(members, { me: ['d1', 'd2'], bob: ['b1', 'b2'] }, 'd1')).toEqual([])
  })
})

describe('parseDeviceSync', () => {
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  it('keeps well-formed fields and drops the rest', () => {
    const admin = 'ab'.repeat(16)
    const sync = parseDeviceSync(
      encode({
        displayName: 'Ann',
        names: { cafe: 'Bob', 'not hex': 'x', beef: 42 },
        usernames: { cafe: '+15551234567' },
        conversations: { '01': { name: 'Team', admins: [admin, 'nope'] }, zz: {} },
      }),
    )
    expect(sync).toEqual({
      displayName: 'Ann',
      names: { cafe: 'Bob' },
      usernames: { cafe: '+15551234567' },
      conversations: { '01': { name: 'Team', admins: [admin] } },
      blocked: undefined,
    })
  })
  it('carries the block list', () => {
    const a = 'cd'.repeat(16)
    expect(parseDeviceSync(encode({ blocked: [a, 'x'] }))?.blocked).toEqual([a])
  })
  it('rejects non-JSON', () => {
    expect(parseDeviceSync(new Uint8Array([0xff]))).toBeUndefined()
  })
})

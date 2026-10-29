import { describe, expect, it } from 'vitest'
import { deviceHex, linkText, ownDevicePlan, parseDeviceSync, parseLinkCode } from './devices'

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

describe('ownDevicePlan', () => {
  const me = 'aa'
  const members = [
    { account: 'bb', device: 'b1' },
    { account: me, device: 'd1' },
    { account: me, device: 'd2' },
  ]
  it('only the lowest own leaf acts', () => {
    expect(ownDevicePlan(members, me, 'd2', ['d1', 'd2', 'd3'])).toBeUndefined()
    expect(ownDevicePlan(members, me, 'd1', ['d1', 'd2', 'd3'])).toEqual({ stale: [], missing: ['d3'] })
  })
  it('removes devices that no longer exist', () => {
    expect(ownDevicePlan(members, me, 'd1', ['d1'])).toEqual({ stale: ['d2'], missing: [] })
  })
  it('does nothing in groups this device is not in', () => {
    expect(ownDevicePlan([{ account: 'bb', device: 'b1' }], me, 'd1', ['d1'])).toBeUndefined()
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
        phones: { cafe: '+15551234567' },
        conversations: { '01': { name: 'Team', admins: [admin, 'nope'] }, zz: {} },
      }),
    )
    expect(sync).toEqual({
      displayName: 'Ann',
      names: { cafe: 'Bob' },
      phones: { cafe: '+15551234567' },
      conversations: { '01': { name: 'Team', admins: [admin] } },
    })
  })
  it('rejects non-JSON', () => {
    expect(parseDeviceSync(new Uint8Array([0xff]))).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { acceptsGroupInfo, activeAdmins, designatedCommitter, parseAdmins } from './roles'

describe('roles', () => {
  it('parses concatenated admin ids', () => {
    const flat = new Uint8Array(32)
    flat[0] = 0xaa
    flat[16] = 0xbb
    expect(parseAdmins(flat)).toEqual(['aa' + '00'.repeat(15), 'bb' + '00'.repeat(15)])
    expect(parseAdmins(new Uint8Array(0))).toEqual([])
  })

  it('keeps only admins who are still members', () => {
    expect(activeAdmins(['a', 'b'], ['b', 'c'])).toEqual(['b'])
    expect(activeAdmins(undefined, ['b'])).toEqual([])
  })

  it('picks the first remaining admin, else the lowest leaf', () => {
    expect(designatedCommitter(['a', 'b'], ['c', 'a', 'b'], [])).toBe('a')
    expect(designatedCommitter(['a', 'b'], ['c', 'a', 'b'], ['a'])).toBe('b')
    expect(designatedCommitter(['a'], ['c', 'a', 'd'], ['a', 'c'])).toBe('d')
    expect(designatedCommitter(['gone'], ['c', 'd'], [])).toBe('c')
    expect(designatedCommitter([], ['c'], ['c'])).toBeUndefined()
  })

  it('accepts group info from admins only, once known', () => {
    expect(acceptsGroupInfo(undefined, 'x')).toBe(true)
    expect(acceptsGroupInfo([], 'x')).toBe(true)
    expect(acceptsGroupInfo(['a'], 'a')).toBe(true)
    expect(acceptsGroupInfo(['a'], 'x')).toBe(false)
  })
})

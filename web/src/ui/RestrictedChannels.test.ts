import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { CoreClient } from '../core/client'
import type { ConversationSummary, MemberInfo } from '../core/protocol'
import { channelFamilies, channelInviteCandidates, RestrictedChannelForm, validChannelName, visibleChildChannels } from './RestrictedChannels'

const member = (account: string, extra: Partial<MemberInfo> = {}): MemberInfo => ({ account, name: account, username: `${account}.27`, isMe: false, isAdmin: false, ...extra })
const conversation = (id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({ id, title: id, isGroup: true, amAdmin: false, memberCount: 2, request: false, unread: 0, lastAt: 0, status: 'active', ...extra })

describe('restricted channels', () => {
  it('renders only the worker-provided children of this parent', () => {
    const child = conversation('child', { channelParentId: 'parent' })
    expect(visibleChildChannels([conversation('parent'), child, conversation('elsewhere', { channelParentId: 'other' })], 'parent')).toEqual([child])
    expect(visibleChildChannels([conversation('parent')], 'parent')).toEqual([])
  })

  it('groups only eligible rows under their actual parents without losing request or search context', () => {
    const parent = conversation('parent')
    const other = conversation('other')
    const child = conversation('child', { channelParentId: parent.id, channelSendPaused: true })
    const request = conversation('request', { channelParentId: parent.id, request: true })
    const orphan = conversation('orphan', { channelParentId: 'missing', status: 'removed' })
    const all = [child, request, other, orphan, parent]
    expect(channelFamilies(all, [child, other, orphan, parent])).toEqual({ families: [
      { parent: other, contextual: false, children: [] }, { parent, contextual: false, children: [child] },
    ], unavailable: [orphan] })
    expect(channelFamilies(all, [request])).toEqual({ families: [{ parent, contextual: true, children: [request] }], unavailable: [] })
    expect(channelFamilies(all, [child])).toEqual({ families: [{ parent, contextual: true, children: [child] }], unavailable: [] })
    expect(channelFamilies([parent], [parent]).families[0].children).toEqual([])
  })

  it('selects only named parent members, excluding self, blocked and existing channel accounts', () => {
    const eligible = member('eligible')
    expect(channelInviteCandidates([
      eligible, member('self', { isMe: true }), member('blocked', { blocked: true }),
      member('unknown', { username: undefined }), member('existing'),
    ], [member('existing')])).toEqual([eligible])
    expect(channelInviteCandidates([], [member('outsider')])).toEqual([])
  })

  it('bounds channel names by trimmed UTF-8 bytes', () => {
    expect(validChannelName('   ')).toBe(false)
    expect(validChannelName('a'.repeat(512))).toBe(true)
    expect(validChannelName('a'.repeat(513))).toBe(false)
    expect(validChannelName('🖖'.repeat(128))).toBe(true)
    expect(validChannelName('🖖'.repeat(129))).toBe(false)
  })

  it('fails closed while the parent roster loads without offering a free-form username field', () => {
    const html = renderToStaticMarkup(createElement(RestrictedChannelForm, { core: {} as CoreClient, parentId: 'parent', onDone: () => {} }))
    expect(html).toContain('Loading parent group members')
    expect(html).toContain('<fieldset disabled=""')
    expect(html).toContain('<button type="submit" disabled=""')
    expect(html).not.toContain('textarea')
    expect(html).not.toContain('Usernames to add')
    const invitation = renderToStaticMarkup(createElement(RestrictedChannelForm, { core: {} as CoreClient, parentId: 'parent', channelId: 'child', onDone: () => {} }))
    expect(invitation).toContain('Invite members')
    expect(invitation).not.toContain('Channel name')
  })
})

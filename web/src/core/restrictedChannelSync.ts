import { canSendRestrictedChannel, type ChannelDevice, type RestrictedChannelSendSnapshot } from './restrictedChannel'

/**
 * A local plan only. This module does not authenticate state, perform MLS
 * operations, persist progress, or enable channel transport. Never expose this
 * plan to parent members who are not channel members.
 */
export type RestrictedChannelSyncPlan =
  | { status: 'invalid' }
  | { status: 'pending'; add: ChannelDevice[]; remove: ChannelDevice[] }
  | { status: 'synchronized'; add: []; remove: [] }

/**
 * Call with a coherent, authenticated parent/channel binding, MLS rosters and
 * confidential invitations. Revalidate them under the mutation lock before
 * every MLS operation. A plan is not proof that an operation succeeded.
 * Keep sends paused until a fresh snapshot passes the send gate, including the
 * caller's durable parent-removal synchronization barrier.
 *
 * An invited account absent from the parent roster makes the plan invalid. The
 * caller must first resolve the invitation against authenticated parent state;
 * this function cannot distinguish a removal from an incomplete roster.
 */
export function planRestrictedChannelSync(snapshot: RestrictedChannelSendSnapshot): RestrictedChannelSyncPlan {
  const { parentConversation, channelConversation, parentEpoch, channelEpoch,
    parentDevices, channelDevices, invitedAccounts } = snapshot
  if (!parentConversation || !channelConversation || parentConversation === channelConversation ||
      !parentEpoch || !channelEpoch || !parentDevices.length || !channelDevices.length || !invitedAccounts.length) {
    return { status: 'invalid' }
  }
  const invited = new Set(invitedAccounts)
  if (invited.size !== invitedAccounts.length || invited.has('')) return { status: 'invalid' }

  function index(devices: readonly ChannelDevice[]): Map<string, Set<string>> | undefined {
    const result = new Map<string, Set<string>>()
    for (const { account, device } of devices) {
      if (!account || !device) return undefined
      const entries = result.get(account) ?? new Set<string>()
      if (entries.has(device)) return undefined
      entries.add(device)
      result.set(account, entries)
    }
    return result
  }
  const parent = index(parentDevices)
  const channel = index(channelDevices)
  if (!parent || !channel || [...invited].some(account => !parent.has(account))) return { status: 'invalid' }

  const add = parentDevices.filter(({ account, device }) => invited.has(account) && !channel.get(account)?.has(device))
    .map(({ account, device }) => ({ account, device }))
  const remove = channelDevices.filter(({ account, device }) => !invited.has(account) || !parent.get(account)?.has(device))
    .map(({ account, device }) => ({ account, device }))
  if (canSendRestrictedChannel(snapshot)) return { status: 'synchronized', add: [], remove: [] }
  return { status: 'pending', add, remove }
}

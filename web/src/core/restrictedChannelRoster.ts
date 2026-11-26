import { toHex, trySplitIdentity } from './ids'
import { matchesRestrictedChannelRoster, type ChannelDevice } from './restrictedChannel'

/** MLS credential identities are the source of account and device membership. */
export function authenticatedChannelRoster(identities: readonly Uint8Array[]): ChannelDevice[] | undefined {
  if (identities.length === 0) return undefined
  const devices = new Set<string>()
  const roster: ChannelDevice[] = []
  for (const identity of identities) {
    const parsed = trySplitIdentity(identity)
    if (!parsed) return undefined
    const device = toHex(parsed.device)
    if (devices.has(device)) return undefined
    devices.add(device)
    roster.push({ account: parsed.account, device })
  }
  return roster
}

/** Exact parent devices for each selected account; directory results cannot add devices. */
export function restrictedInviteRoster(parent: readonly ChannelDevice[], accounts: readonly string[]): ChannelDevice[] | undefined {
  const invited = new Set(accounts)
  if (invited.size === 0 || invited.size !== accounts.length || invited.has('')) return undefined
  const selected = parent.filter(({ account }) => invited.has(account))
  if (new Set(selected.map(({ account }) => account)).size !== invited.size) return undefined
  return selected
}

/** Removal never admits a new account. Retain an observed revocation until the child removes that device. */
export function revokedRestrictedChannelDevices(
  parent: readonly ChannelDevice[], channel: readonly ChannelDevice[], previouslyRevoked: readonly string[] = [],
): ChannelDevice[] {
  const eligible = new Set(parent.map(({ account, device }) => account + device))
  const revoked = new Set(previouslyRevoked)
  return channel.filter(({ account, device }) => revoked.has(device) || !eligible.has(account + device))
}

/** A binding is only valid for a current parent admin whose exact device is in both groups. */
export function acceptsRestrictedChannelInfo(input: {
  parentConversation: string
  channelConversation: string
  parentDevices: readonly ChannelDevice[]
  channelDevices: readonly ChannelDevice[]
  parentAdmins: readonly string[]
  sender: ChannelDevice
  self: ChannelDevice
  parentStable: boolean
}): boolean {
  const { parentConversation, channelConversation, parentDevices, channelDevices, parentAdmins, sender, self, parentStable } = input
  const inChannel = (who: ChannelDevice) => channelDevices.some(({ account, device }) => account === who.account && device === who.device)
  if (!parentStable || !parentConversation || !channelConversation || parentConversation === channelConversation ||
      !parentAdmins.includes(sender.account) || !inChannel(sender) || !inChannel(self)) return false
  return matchesRestrictedChannelRoster(parentDevices, [...new Set(channelDevices.map(({ account }) => account))], channelDevices)
}

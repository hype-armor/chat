/**
 * Send gate for a restricted channel. This module does not authenticate rosters,
 * persist state, perform MLS updates, or send messages. It is not wired to UI or
 * transport. Callers must bind these values to authenticated MLS state.
 */
export type ChannelDevice = { account: string; device: string }

export type RestrictedChannelSendSnapshot = {
  parentConversation: string
  channelConversation: string
  parentEpoch: string
  channelEpoch: string
  /** False while a parent removal or its channel update is unresolved. */
  removalsSynchronized: boolean
  parentDevices: readonly ChannelDevice[]
  invitedAccounts: readonly string[]
  channelDevices: readonly ChannelDevice[]
}

/**
 * Permit a send only when the authenticated channel roster exactly matches all
 * current parent devices of invited accounts. The caller must obtain both MLS
 * rosters and the confidential invitation list from authenticated state, and
 * must validate the snapshot and enqueue the send under the same mutation lock.
 * An empty or unavailable roster is not evidence of synchronization.
 *
 * This conservative rule also pauses sends during additions or device changes.
 * It does not enforce advisory roles against modified clients.
 */
export function canSendRestrictedChannel(snapshot: RestrictedChannelSendSnapshot): boolean {
  const { parentConversation, channelConversation, parentEpoch, channelEpoch,
    removalsSynchronized, parentDevices, invitedAccounts, channelDevices } = snapshot
  if (!parentConversation || !channelConversation || parentConversation === channelConversation ||
      !parentEpoch || !channelEpoch || removalsSynchronized !== true) return false
  return matchesRestrictedChannelRoster(parentDevices, invitedAccounts, channelDevices)
}

/** Compare rosters only. This does not establish that either roster is current. */
export function matchesRestrictedChannelRoster(
  parentDevices: readonly ChannelDevice[], invitedAccounts: readonly string[], channelDevices: readonly ChannelDevice[],
): boolean {
  if (parentDevices.length === 0 || invitedAccounts.length === 0 || channelDevices.length === 0) return false
  const invited = new Set(invitedAccounts)
  if (invited.size !== invitedAccounts.length || invited.has('')) return false

  // Nested maps avoid collisions between opaque identifiers with separators.
  const parent = new Map<string, Set<string>>()
  for (const { account, device } of parentDevices) {
    if (!account || !device) return false
    const devices = parent.get(account) ?? new Set<string>()
    if (devices.has(device)) return false
    devices.add(device)
    parent.set(account, devices)
  }
  for (const account of invited) if (!parent.has(account)) return false

  const seen = new Map<string, Set<string>>()
  for (const { account, device } of channelDevices) {
    if (!account || !device || !invited.has(account) || !parent.get(account)?.has(device)) return false
    const devices = seen.get(account) ?? new Set<string>()
    if (devices.has(device)) return false
    devices.add(device)
    seen.set(account, devices)
  }
  for (const account of invited) {
    if (seen.get(account)?.size !== parent.get(account)?.size) return false
  }
  return true
}

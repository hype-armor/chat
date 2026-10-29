// Linked-device rules (ADR-0019). Pure functions, shared by the engine and tests.

const LINK_PREFIX = 'chat-link:v1:'

/** What the new device shows as a QR code. */
export function linkText(code: string): string {
  return LINK_PREFIX + code
}

/** Accepts a scanned `chat-link:v1:…` text or a typed code; undefined if neither. */
export function parseLinkCode(input: string): string | undefined {
  const text = input.trim()
  const code = text.startsWith(LINK_PREFIX) ? text.slice(LINK_PREFIX.length) : text
  return /^[A-Za-z0-9_-]{22}$/.test(code) ? code : undefined
}

/** Server device ids are UUIDs; identities and recipients use plain hex. */
export function deviceHex(uuid: string): string {
  return uuid.replaceAll('-', '').toLowerCase()
}

export type Member = { account: string; device: string }

/** What this device should change in a group for one member account. */
export type DevicePlan = { account: string; missing: string[]; stale: string[] }

/**
 * Keeps every member's devices in a group in line with the server's device
 * lists (ADR-0022). `live` maps each account to its current devices (hex);
 * an account missing from it no longer exists. For each account the actor
 * is its own lowest leaf that is still a live device or, if it has none
 * (all lost or deleted), the group's lowest live leaf: so only one device
 * acts, and a restored or deleted account is still handled. Returns the
 * changes this device should make (`members` is in leaf order).
 */
export function memberDevicePlan(
  members: Member[],
  live: Record<string, string[]>,
  thisDevice: string,
): DevicePlan[] {
  const isLive = (m: Member) => (live[m.account] ?? []).includes(m.device)
  const groupActor = members.find(isLive)?.device
  const accounts = [...new Set(members.map((m) => m.account))]
  return accounts.flatMap((account) => {
    const leaves = members.filter((m) => m.account === account)
    const actor = leaves.find(isLive)?.device ?? groupActor
    if (actor !== thisDevice) return []
    const devices = live[account] ?? []
    const inGroup = leaves.map((m) => m.device)
    const plan = {
      account,
      missing: devices.filter((d) => !inGroup.includes(d)),
      stale: inGroup.filter((d) => !devices.includes(d)),
    }
    return plan.missing.length + plan.stale.length > 0 ? [plan] : []
  })
}

/** State shared between an account's devices over their self conversation. */
export type DeviceSync = {
  displayName?: string
  /** Account id → display name. */
  names: Record<string, string>
  /** Account id → username number. */
  usernames: Record<string, string>
  /** Conversation id → group name and admins. */
  conversations: Record<string, { name?: string; admins?: string[] }>
  /** Blocked account ids; the whole list, latest change wins (FR-ID-8). */
  blocked?: string[]
}

const strings = (v: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(typeof v === 'object' && v ? v : {}).filter(
      ([k, s]) => /^[0-9a-f]{1,64}$/.test(k) && typeof s === 'string' && s.length <= 64,
    ),
  ) as Record<string, string>

/** Parses a `DeviceSync` from another device, dropping anything malformed. */
export function parseDeviceSync(bytes: Uint8Array): DeviceSync | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || !raw) return undefined
  const r = raw as Record<string, unknown>
  const conversations: DeviceSync['conversations'] = {}
  for (const [id, meta] of Object.entries(typeof r.conversations === 'object' && r.conversations ? r.conversations : {})) {
    if (!/^[0-9a-f]{1,128}$/.test(id) || typeof meta !== 'object' || !meta) continue
    const m = meta as Record<string, unknown>
    conversations[id] = {
      name: typeof m.name === 'string' ? m.name.slice(0, 64) : undefined,
      admins: Array.isArray(m.admins) ? m.admins.filter((a): a is string => typeof a === 'string' && /^[0-9a-f]{32}$/.test(a)) : undefined,
    }
  }
  return {
    displayName: typeof r.displayName === 'string' ? r.displayName.slice(0, 64) : undefined,
    names: strings(r.names),
    usernames: strings(r.usernames),
    conversations,
    blocked: Array.isArray(r.blocked)
      ? r.blocked.filter((a): a is string => typeof a === 'string' && /^[0-9a-f]{32}$/.test(a))
      : undefined,
  }
}

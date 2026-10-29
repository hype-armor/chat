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

/**
 * How this device should bring a group's set of this account's devices in
 * line with the account's current devices (`mine`, hex): which to remove and
 * which to add. Only the account's device with the lowest leaf index acts
 * (`members` is in leaf order), so devices don't race each other; others get
 * `undefined`.
 */
export function ownDevicePlan(
  members: Member[],
  me: string,
  thisDevice: string,
  mine: string[],
): { stale: string[]; missing: string[] } | undefined {
  const own = members.filter((m) => m.account === me).map((m) => m.device)
  if (own[0] !== thisDevice) return undefined
  return {
    stale: own.filter((d) => !mine.includes(d)),
    missing: mine.filter((d) => !own.includes(d)),
  }
}

/** State shared between an account's devices over their self conversation. */
export type DeviceSync = {
  displayName?: string
  /** Account id → display name. */
  names: Record<string, string>
  /** Account id → phone number. */
  phones: Record<string, string>
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
    phones: strings(r.phones),
    conversations,
    blocked: Array.isArray(r.blocked)
      ? r.blocked.filter((a): a is string => typeof a === 'string' && /^[0-9a-f]{32}$/.test(a))
      : undefined,
  }
}

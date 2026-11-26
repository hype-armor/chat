/** Pure topic-state rules. This module does not authenticate or transport messages. */
export const MAX_GROUP_TOPIC_BYTES = 512

export type GroupTopic = {
  text: string
  clock: number
  account: string
  device: string
}

/**
 * The caller must obtain account and device from the authenticated MLS sender,
 * verify membership at the message epoch, and pass only private group messages.
 * Never pass sender identities from the encrypted body or an outer envelope.
 */
export function applyGroupTopic(
  current: GroupTopic | undefined,
  body: unknown,
  sender: { account: string; device: string },
): GroupTopic | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return current
  const candidate = body as Record<string, unknown>
  return mergeTopic(current, { text: candidate.text, clock: candidate.clock, account: sender.account, device: sender.device })
}

/**
 * Merge a current-member attestation, not proof of the original author.
 * The caller must authenticate the attester and verify current membership and
 * group binding. This function does not implement snapshot delivery or recovery.
 */
export function applyGroupTopicSnapshot(current: GroupTopic | undefined, snapshot: unknown): GroupTopic | undefined {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return current
  const candidate = snapshot as Record<string, unknown>
  return mergeTopic(current, candidate)
}

function mergeTopic(current: GroupTopic | undefined, candidate: Record<string, unknown>): GroupTopic | undefined {
  if (typeof candidate.text !== 'string' || typeof candidate.clock !== 'number' ||
      !Number.isSafeInteger(candidate.clock) || candidate.clock < 1 ||
      new TextEncoder().encode(candidate.text).length > MAX_GROUP_TOPIC_BYTES ||
      typeof candidate.account !== 'string' || !candidate.account ||
      typeof candidate.device !== 'string' || !candidate.device) return current
  const next: GroupTopic = { text: candidate.text, clock: candidate.clock, account: candidate.account, device: candidate.device }
  return !current || compareTopic(next, current) > 0 ? next : current
}

/** Return undefined when an update cannot advance the accepted clock safely. */
export function nextGroupTopicClock(current: GroupTopic | undefined): number | undefined {
  if (!current) return 1
  return Number.isSafeInteger(current.clock) && current.clock >= 1 && current.clock < Number.MAX_SAFE_INTEGER
    ? current.clock + 1
    : undefined
}

/** All tie breakers are authenticated sender identities or encrypted content. */
export function compareTopic(a: GroupTopic, b: GroupTopic): number {
  if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1
  for (const key of ['account', 'device', 'text'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return 0
}

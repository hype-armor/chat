// Live location (FR-LOC-2/3/6, doc 06 §2): pure rules shared by the engine
// and tests.

/** The durations people can choose. */
export const LIVE_DURATIONS_MS = [15 * 60_000, 60 * 60_000, 8 * 60 * 60_000] as const
/** Never more often than this, so a session sends at most a few thousand updates. */
export const MIN_UPDATE_MS = 10_000
/** Without moving, still refresh this often so others see it's live. */
export const HEARTBEAT_MS = 60_000
/** Movement worth an update sooner than the heartbeat. */
export const MIN_MOVE_M = 20
/** Allowance for the sender's clock when checking a session's end. */
const CLOCK_SLACK_MS = 5 * 60_000

type Point = { latitude: number; longitude: number }

/** Great-circle distance in metres (haversine). */
export function distanceM(a: Point, b: Point): number {
  const rad = Math.PI / 180
  const dLat = (b.latitude - a.latitude) * rad
  const dLon = (b.longitude - a.longitude) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Whether a new fix should go out now. */
export function updateDue(now: number, lastSentAt: number, last: Point | undefined, next: Point): boolean {
  if (now - lastSentAt < MIN_UPDATE_MS) return false
  if (!last || now - lastSentAt >= HEARTBEAT_MS) return true
  return distanceM(last, next) >= MIN_MOVE_M
}

/** A received session end that makes sense: in the future, at most 8 hours from `sentAt`. */
export function plausibleExpiry(expiresAt: number, sentAt: number): boolean {
  return (
    Number.isFinite(expiresAt) &&
    expiresAt > sentAt &&
    expiresAt <= sentAt + LIVE_DURATIONS_MS[LIVE_DURATIONS_MS.length - 1] + CLOCK_SLACK_MS
  )
}

import type { LocalityInfo, LocalityPlace } from './protocol'

export const LOCALITY_TTL_MS = 60 * 60_000
export const LOCALITY_REFRESH_MS = 15 * 60_000
export const LOCALITY_CLOCK_TOLERANCE_MS = 2_000

export type LocalityLease = { account: string; device: string; sentAt: number; expiresAt: number; place?: LocalityPlace }

/** Untrusted MLS metadata still needs bounded text and lifetime validation. */
export function safeLocality(city: string, region: string, country: string): LocalityPlace | undefined {
  if (!city || city.length > 80 || city !== city.trim() || /[<>\p{Cc}\p{Cf}]/u.test(city)) return undefined
  if (region.length > 80 || region !== region.trim() || /[<>\p{Cc}\p{Cf}]/u.test(region) || !/^[A-Z]{2}$/.test(country)) return undefined
  return { city, region, country }
}

export function localityLabel(place: LocalityPlace): string {
  return `Near ${[place.city, place.region || undefined, place.country === 'US' ? undefined : place.country].filter(Boolean).join(', ')}`
}

export function localityLease(account: string, device: string, sentAt: number, expiresAt: number, city: string, region: string, country: string, now: number, previous?: LocalityLease): LocalityLease | undefined {
  if (![sentAt, expiresAt].every((n) => Number.isSafeInteger(n) && n > 0)) return undefined
  if (expiresAt <= sentAt || expiresAt - sentAt > LOCALITY_TTL_MS || expiresAt <= now) return undefined
  if (sentAt > now + LOCALITY_CLOCK_TOLERANCE_MS || sentAt < now - LOCALITY_TTL_MS) return undefined
  const clearing = city === '' && region === '' && country === ''
  const place = clearing ? undefined : safeLocality(city, region, country)
  if (!clearing && !place) return undefined
  if (previous && (sentAt < previous.sentAt || (sentAt === previous.sentAt && (!clearing || !previous.place)))) return undefined
  return { account, device, sentAt, expiresAt: Math.min(expiresAt, now + LOCALITY_TTL_MS), place }
}

export function visibleLocality(leases: LocalityLease[], account: string, now: number): LocalityInfo | undefined {
  const lease = leases.filter((l) => l.account === account && l.place && l.expiresAt > now)
    .sort((a, b) => b.sentAt - a.sentAt || a.device.localeCompare(b.device))[0]
  return lease?.place ? { ...lease.place, updatedAt: lease.sentAt, expiresAt: lease.expiresAt } : undefined
}

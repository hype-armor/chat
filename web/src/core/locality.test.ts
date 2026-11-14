import { describe, expect, it } from 'vitest'
import { LOCALITY_TTL_MS, localityLabel, localityLease, safeLocality, visibleLocality } from './locality'
import { TypingClock } from './typing'

const now = 10 * LOCALITY_TTL_MS
const city = { city: 'Austin', region: 'TX', country: 'US' }
const update = (sentAt = now, expiresAt = sentAt + LOCALITY_TTL_MS, previous?: ReturnType<typeof localityLease>, values = city) =>
  localityLease('alice', 'phone', sentAt, expiresAt, values.city, values.region, values.country, now, previous)

describe('coarse locality leases', () => {
  it('accepts bounded international names, missing regions, and approximate labels', () => {
    expect(safeLocality('Montréal', 'Québec', 'CA')).toEqual({ city: 'Montréal', region: 'Québec', country: 'CA' })
    expect(safeLocality('Paris', '', 'FR')).toEqual({ city: 'Paris', region: '', country: 'FR' })
    expect(localityLabel(city)).toBe('Near Austin, TX')
    expect(localityLabel({ city: 'Paris', region: '', country: 'FR' })).toBe('Near Paris, FR')
    for (const bad of ['', ' padded ', '<html>', 'control\n', 'direction\u202e', 'x'.repeat(81)]) expect(safeLocality(bad, 'TX', 'US')).toBeUndefined()
    expect(safeLocality('Austin', 'x'.repeat(81), 'US')).toBeUndefined()
    expect(safeLocality('Austin', 'TX', 'not-a-country')).toBeUndefined()
  })

  it('rejects expired, distant-future, oversized, and unsafe timestamps', () => {
    expect(update()).toMatchObject({ place: city })
    expect(update(now - 1, now)).toBeUndefined()
    expect(update(now + 2001)).toBeUndefined()
    expect(update(now, now + LOCALITY_TTL_MS + 1)).toBeUndefined()
    expect(update(NaN)).toBeUndefined()
    expect(update(0)).toBeUndefined()
    expect(update(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined()
  })

  it('orders updates and lets a revocation win a timestamp tie', () => {
    const first = update()!
    expect(update(now - 1, now + LOCALITY_TTL_MS - 1, first)).toBeUndefined()
    expect(update(now, now + LOCALITY_TTL_MS, first)).toBeUndefined()
    const tombstone = update(now, now + LOCALITY_TTL_MS, first, { city: '', region: '', country: '' })!
    expect(tombstone.place).toBeUndefined()
    expect(update(now, now + LOCALITY_TTL_MS, tombstone)).toBeUndefined()
    expect(visibleLocality([tombstone], 'alice', now)).toBeUndefined()
  })

  it('requires all empty fields for a revocation and never accepts partial labels', () => {
    expect(update(now, now + 100, undefined, { ...city, city: '' })).toBeUndefined()
    expect(update(now, now + 100, undefined, { ...city, country: '' })).toBeUndefined()
  })

  it('selects the newest active device and expires independently of wall-clock rollback', () => {
    const phone = update()!
    const laptop = { ...phone, device: 'laptop', sentAt: now + 1, place: { ...city, city: 'Dallas' } }
    expect(visibleLocality([phone, laptop], 'alice', now)?.city).toBe('Dallas')
    expect(visibleLocality([phone, laptop], 'bob', now)).toBeUndefined()
    const clock = new TypingClock()
    clock.now(now, 100)
    const elapsed = clock.now(now - LOCALITY_TTL_MS, 100 + LOCALITY_TTL_MS)
    expect(visibleLocality([phone, laptop], 'alice', elapsed)).toBeUndefined()
  })
})

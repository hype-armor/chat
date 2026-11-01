import { describe, expect, it } from 'vitest'
import { isApple, mapsAppLink } from './mapsLink'

describe('maps app links', () => {
  it('recognises Apple devices, iPad included', () => {
    expect(isApple('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe(true)
    expect(isApple('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true)
    expect(isApple('Mozilla/5.0 (Linux; Android 15; Pixel 9)', 5)).toBe(false)
    expect(isApple('Mozilla/5.0 (X11; Linux x86_64)', 0)).toBe(false)
  })

  it('opens Apple Maps on Apple devices and geo: elsewhere', () => {
    expect(mapsAppLink(48.8584, 2.2945, undefined, true)).toBe(
      'https://maps.apple.com/?ll=48.8584,2.2945&q=Shared%20location',
    )
    expect(mapsAppLink(48.8584, 2.2945, 'Café & co', true)).toBe('https://maps.apple.com/?ll=48.8584,2.2945&q=Caf%C3%A9%20%26%20co')
    expect(mapsAppLink(48.8584, 2.2945, undefined, false)).toBe('geo:48.8584,2.2945')
  })
})

// "Open in maps app" (FR-LOC-1): hands a point to the device's own maps app,
// only when tapped. Android and most others understand `geo:` links; Apple
// devices don't, and open Apple Maps from a maps.apple.com link instead.

/** iPhone, iPad (which reports itself as a Mac) and Mac. */
export function isApple(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod|Macintosh/.test(userAgent) || (userAgent.includes('Mac') && maxTouchPoints > 1)
}

export function mapsAppLink(latitude: number, longitude: number, label: string | undefined, apple: boolean): string {
  const ll = `${latitude},${longitude}`
  if (apple) {
    const q = encodeURIComponent(label || 'Shared location')
    return `https://maps.apple.com/?ll=${ll}&q=${q}`
  }
  return label ? `geo:${ll}?q=${ll}(${encodeURIComponent(label)})` : `geo:${ll}`
}

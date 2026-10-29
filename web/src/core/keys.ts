// Safety numbers and key-change rules (ADR-0020). Pure functions, shared by
// the engine and tests.

const VERIFY_PREFIX = 'chat-verify:v1:'

/** Account id → every device signature key (hex) seen for it. */
export type KeyBook = Record<string, string[]>

/**
 * Records `keys` for `account`. Returns the keys never seen before, or none
 * the first time an account is seen (trust on first use).
 */
export function observeKeys(book: KeyBook, account: string, keys: string[]): string[] {
  const known = book[account]
  const added = keys.filter((k) => !known?.includes(k))
  book[account] = [...new Set([...(known ?? []), ...keys])].sort()
  return known ? [...new Set(added)] : []
}

export type Verification = 'unverified' | 'verified' | 'changed'

/** Verified while every key seen for the contact was verified. */
export function verification(verified: string[] | undefined, seen: string[] | undefined): Verification {
  if (!verified) return 'unverified'
  return (seen ?? []).every((k) => verified.includes(k)) ? 'verified' : 'changed'
}

/** 60 digits as 12 groups of 5, for reading aloud. */
export function formatSafetyNumber(digits: string): string {
  return digits.match(/.{1,5}/g)?.join(' ') ?? ''
}

/** What a safety-number QR code holds. */
export function verifyText(digits: string): string {
  return VERIFY_PREFIX + digits
}

/** Whether a scanned code matches our safety number. */
export function scannedMatches(scanned: string, digits: string): boolean {
  return scanned.trim() === verifyText(digits)
}

import type { StorageUsage } from './protocol'

/** Reject malformed or inexact totals rather than display a misleading quota. */
export function parseStorageUsage(raw: unknown): StorageUsage {
  const usage = raw as Record<string, unknown> | null
  const bytes = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (!usage || !bytes(usage.used_bytes) || !bytes(usage.reserved_bytes) ||
      !(usage.limit_bytes === null || bytes(usage.limit_bytes)) ||
      !Number.isSafeInteger(usage.used_bytes + usage.reserved_bytes)) {
    throw new Error('The server returned invalid storage usage')
  }
  return { usedBytes: usage.used_bytes, reservedBytes: usage.reserved_bytes, limitBytes: usage.limit_bytes }
}

// Identifier helpers shared by the worker and its tests.

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error(`invalid hex: ${hex}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function uuidToBytes(uuid: string): Uint8Array {
  return fromHex(uuid.replaceAll('-', ''))
}

/** MLS identity = 16-byte account id ‖ 16-byte device id. */
export function makeIdentity(accountId: string, deviceId: string): Uint8Array {
  const out = new Uint8Array(32)
  out.set(uuidToBytes(accountId), 0)
  out.set(uuidToBytes(deviceId), 16)
  return out
}

export function splitIdentity(identity: Uint8Array): { account: string; device: Uint8Array } {
  if (identity.length !== 32) throw new Error('identity must be 32 bytes')
  return { account: toHex(identity.slice(0, 16)), device: identity.slice(16) }
}

export function randomId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

/** Remembers recently processed message ids so redeliveries are skipped. */
export class RecentIds {
  private order: string[]
  private set: Set<string>

  constructor(
    initial: string[] = [],
    private readonly limit = 2000,
  ) {
    this.order = initial.slice(-limit)
    this.set = new Set(this.order)
  }

  has(id: string): boolean {
    return this.set.has(id)
  }

  add(id: string) {
    if (this.set.has(id)) return
    this.order.push(id)
    this.set.add(id)
    while (this.order.length > this.limit) this.set.delete(this.order.shift()!)
  }

  toJSON(): string[] {
    return this.order
  }
}

/** wasm-bindgen returns `Uint8Array<ArrayBufferLike>`; its buffers are always
 * plain (non-shared) copies, which browser APIs require. */
export function plain(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>
}

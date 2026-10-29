// Encrypted backups (ADR-0022): recovery keys and sealing. Only WebCrypto
// primitives (HKDF-SHA256, AES-256-GCM) and the platform's gzip.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' // RFC 4648 base32
const MAGIC = new TextEncoder().encode('CHB1')

/** 128 random bits. */
export function newRecoveryKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

/** 26 base32 characters in groups of four: `ABCD-EFGH-…-YZ`. */
export function formatRecoveryKey(key: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of key) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out.match(/.{1,4}/g)!.join('-')
}

/** Reads a typed recovery key (any case, spaces or dashes); undefined if malformed. */
export function parseRecoveryKey(text: string): Uint8Array | undefined {
  const chars = text.toUpperCase().replace(/[\s-]/g, '')
  if (chars.length !== 26 || [...chars].some((c) => !ALPHABET.includes(c))) return undefined
  const out = new Uint8Array(16)
  let bits = 0
  let value = 0
  let i = 0
  for (const c of chars) {
    value = (value << 5) | ALPHABET.indexOf(c)
    bits += 5
    if (bits >= 8) {
      out[i++] = (value >>> (bits - 8)) & 255
      bits -= 8
    }
  }
  return i === 16 ? out : undefined
}

export type BackupKeys = {
  /** Proves the recovery key to the server on restore; it stores only its hash. */
  auth: Uint8Array
  /** Encrypts backups; not extractable. */
  encryption: CryptoKey
}

export async function deriveBackupKeys(recoveryKey: Uint8Array): Promise<BackupKeys> {
  const base = await crypto.subtle.importKey('raw', recoveryKey as BufferSource, 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ])
  const params = (info: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: new TextEncoder().encode(info),
  })
  const auth = new Uint8Array(await crypto.subtle.deriveBits(params('chat-backup-v1 auth'), base, 256))
  const encryption = await crypto.subtle.deriveKey(
    params('chat-backup-v1 encryption'),
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  return { auth, encryption }
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

/** JSON → gzip → AES-GCM: `CHB1` ‖ 12-byte IV ‖ ciphertext. */
export async function sealBackup(key: CryptoKey, payload: unknown): Promise<Uint8Array> {
  const compressed = await pipe(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream('gzip'))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed as BufferSource))
  const out = new Uint8Array(MAGIC.length + iv.length + ct.length)
  out.set(MAGIC)
  out.set(iv, MAGIC.length)
  out.set(ct, MAGIC.length + iv.length)
  return out
}

/** Reverses `sealBackup`; throws if the key is wrong or the data damaged. */
export async function openBackup<T>(key: CryptoKey, sealed: Uint8Array): Promise<T> {
  if (sealed.length < 16 + 28 || MAGIC.some((b, i) => sealed[i] !== b)) throw new Error('not a backup')
  const iv = sealed.slice(4, 16)
  const compressed = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed.slice(16) as BufferSource),
  )
  const json = await pipe(compressed, new DecompressionStream('gzip'))
  return JSON.parse(new TextDecoder().decode(json)) as T
}

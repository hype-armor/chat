// REST calls to the chat server (docs/11-api.md).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  const json = text ? JSON.parse(text) : undefined
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `request failed (${res.status})`)
  return json as T
}

export type Registered = { account_id: string; device_id: string; token: string }

export const api = {
  requestCode: (phone: string) => post<void>('/v1/auth/request-code', { phone }),
  verify: (phone: string, code: string, identityKey: string) =>
    post<Registered>('/v1/auth/verify', { phone, code, identity_key: identityKey }),
  uploadKeyPackages: (token: string, keyPackages: string[]) =>
    post<void>('/v1/keys', { key_packages: keyPackages }, token),
  lookup: (token: string, phone: string) =>
    post<{ account_id: string; device_ids: string[] }>('/v1/lookup', { phone }, token),
  claim: (token: string, deviceIds: string[]) =>
    post<{ key_packages: Record<string, string> }>('/v1/keys/claim', { device_ids: deviceIds }, token),
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

// REST calls to the chat server (docs/11-api.md).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function get<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(path, token ? { headers: { authorization: `Bearer ${token}` } } : undefined)
  const json = await res.json().catch(() => undefined)
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `request failed (${res.status})`)
  return json as T
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

async function bytes(method: 'GET' | 'PUT', path: string, token: string, body?: Uint8Array): Promise<Uint8Array> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (body) headers['content-type'] = 'application/octet-stream'
  const res = await fetch(path, { method, headers, body: body as BodyInit | undefined })
  if (!res.ok) {
    const json = await res.json().catch(() => undefined)
    throw new ApiError(res.status, json?.error ?? `request failed (${res.status})`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

/** Uploads a sealed attachment; the browser sends its Content-Length. */
async function uploadBlob(token: string, body: Blob): Promise<{ blob_id: string; expires_in_days: number }> {
  const res = await fetch('/v1/blobs', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body,
  })
  const json = await res.json().catch(() => undefined)
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `upload failed (${res.status})`)
  return json
}

/** One byte range of a blob (resumable downloads, ADR-0025). */
async function downloadBlobRange(token: string, id: string, from: number, to: number): Promise<Blob> {
  const res = await fetch(`/v1/blobs/${id}`, {
    headers: { authorization: `Bearer ${token}`, range: `bytes=${from}-${to - 1}` },
  })
  if (res.status === 404) throw new ApiError(404, 'This file has expired (files are kept 30 days)')
  if (!res.ok) {
    const json = await res.json().catch(() => undefined)
    throw new ApiError(res.status, json?.error ?? `download failed (${res.status})`)
  }
  return res.blob()
}

async function uploadPart(token: string, id: string, part: number, body: Blob): Promise<void> {
  const res = await fetch(`/v1/blobs/uploads/${id}/${part}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body,
  })
  if (!res.ok) {
    const json = await res.json().catch(() => undefined)
    throw new ApiError(res.status, json?.error ?? `upload failed (${res.status})`)
  }
}

async function putJson(path: string, body: unknown, token: string): Promise<void> {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const json = await res.json().catch(() => undefined)
    throw new ApiError(res.status, json?.error ?? `request failed (${res.status})`)
  }
}

export type Registered = { account_id: string; device_id: string; token: string; username: string }

export type ReportReason = 'spam' | 'harassment' | 'other'

export type ReportBody = {
  account_id: string
  reason: ReportReason
  messages: { text: string; sent_at_ms: number }[]
}

export type ServerDevice = { device_id: string; added_on: string; last_seen_on: string | null; current: boolean }

export const api = {
  register: (username: string, invite: string | undefined, identityKey: string) =>
    post<Registered>('/v1/register', { username, invite, identity_key: identityKey }),
  setBackupKey: (token: string, authHash: string) => putJson('/v1/backup/key', { auth_hash: authHash }, token),
  uploadBackup: (token: string, sealed: Uint8Array) => bytes('PUT', '/v1/backup', token, sealed),
  downloadBackup: (token: string) => bytes('GET', '/v1/backup', token),
  uploadBlob,
  downloadBlobRange,
  uploadPart,
  createUpload: (token: string, size: number) =>
    post<{ upload_id: string; part_bytes: number; parts: number }>('/v1/blobs/uploads', { size }, token),
  uploadStatus: (token: string, id: string) =>
    get<{ parts: number; received: number[] }>(`/v1/blobs/uploads/${id}`, token),
  completeUpload: (token: string, id: string) =>
    post<{ blob_id: string; expires_in_days: number }>(`/v1/blobs/uploads/${id}/complete`, {}, token),
  deleteBackup: (token: string) => post<void>('/v1/backup/delete', {}, token),
  restore: (username: string, auth: string, identityKey: string) =>
    post<Registered>('/v1/backup/restore', { username, auth, identity_key: identityKey }),
  createInvite: (token: string) => post<{ code: string; expires_in_days: number }>('/v1/invites', {}, token),
  uploadKeyPackages: (token: string, keyPackages: string[]) =>
    post<void>('/v1/keys', { key_packages: keyPackages }, token),
  lookup: (token: string, username: string) =>
    post<{ account_id: string; device_ids: string[] }>('/v1/lookup', { username }, token),
  pushKey: () => get<{ public_key: string }>('/v1/push/key'),
  subscribePush: (token: string, subscription: PushSubscriptionJSON) =>
    post<void>('/v1/push/subscription', subscription, token),
  unsubscribePush: (token: string) => post<void>('/v1/push/unsubscribe', {}, token),
  groupEpoch: (token: string, groupId: string) =>
    post<{ epoch: number; last_commit_hash: string }>('/v1/groups/epoch', { group_id: groupId }, token),
  iceServers: (token: string) =>
    get<{ ice_servers: { urls: string[]; username?: string; credential?: string }[] }>('/v1/turn', token),
  devices: (token: string) => get<{ devices: ServerDevice[] }>('/v1/devices', token),
  devicesOf: (token: string, accountIds: string[]) =>
    post<{ devices: Record<string, string[]> }>('/v1/devices/of', { account_ids: accountIds }, token),
  removeDevice: (token: string, deviceId: string) => post<void>('/v1/devices/remove', { device_id: deviceId }, token),
  linkStart: () => post<{ code: string }>('/v1/link/start', {}),
  linkApprove: (token: string, code: string) => post<void>('/v1/link/approve', { code }, token),
  linkStatus: (token: string, code: string) => post<{ device_id: string | null }>('/v1/link/status', { code }, token),
  linkComplete: (code: string, identityKey: string) =>
    post<Registered>('/v1/link/complete', { code, identity_key: identityKey }),
  deleteAccount: (token: string, username: string) => post<void>('/v1/account/delete', { username }, token),
  report: (token: string, report: ReportBody) => post<void>('/v1/reports', report, token),
  keyCount: (token: string) => get<{ available: number }>('/v1/keys/count', token),
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

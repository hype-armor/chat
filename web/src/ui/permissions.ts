/** Browser grants belong to the browser and OS, not to application storage. */
export type PermissionKind = 'camera' | 'microphone' | 'camera-and-microphone' | 'location'

const names: Record<PermissionKind, string> = {
  camera: 'camera',
  microphone: 'microphone',
  'camera-and-microphone': 'camera and microphone',
  location: 'location',
}

/** Guidance only: never probes or requests access, and never promises a persistent grant. */
export function permissionGuidance(kind: PermissionKind): string {
  return `Manage ${names[kind]} access in this site's browser settings and your device settings. Your browser may ask again for temporary grants or private browsing. The app cannot remember permission for your browser.`
}

export function mediaAccessError(error: unknown, kind: Exclude<PermissionKind, 'location'>): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `Cannot access the ${names[kind]}. ${permissionGuidance(kind)}`
  }
  if (name === 'NotFoundError') return `No ${names[kind]} found. Connect a device and try again.`
  if (name === 'NotReadableError') return `The ${names[kind]} is unavailable. Close other apps using it and try again.`
  if (name === 'OverconstrainedError') return `The requested ${names[kind]} is unavailable. Choose another device and try again.`
  return error instanceof Error ? error.message : String(error)
}

export function stopMedia(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop()
}

/**
 * Owns one user-initiated capture. Concurrent starts do not request again.
 * Cancellation stops active tracks and any tracks returned by a late grant.
 * It never caches a stream for a later operation or retries a permission request.
 */
export class MediaCapture {
  private pending = false
  private cancelled = false
  private stream?: MediaStream

  async request(constraints: MediaStreamConstraints): Promise<MediaStream | undefined> {
    if (this.cancelled || this.pending || this.stream) return undefined
    this.pending = true
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      if (this.cancelled) {
        stopMedia(stream)
        return undefined
      }
      this.stream = stream
      return stream
    } catch (error) {
      if (!this.cancelled) throw error
      return undefined
    } finally {
      this.pending = false
    }
  }

  cancel() {
    this.cancelled = true
    if (this.stream) stopMedia(this.stream)
    this.stream = undefined
  }
}

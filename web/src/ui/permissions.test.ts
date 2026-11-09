import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaCapture, mediaAccessError, permissionGuidance } from './permissions'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  const grant = deferred<MediaStream>()
  const getUserMedia = vi.fn(() => grant.promise)
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  return { grant, getUserMedia, stop, stream, capture: new MediaCapture() }
}

afterEach(() => vi.unstubAllGlobals())

describe('user-initiated media capture', () => {
  it('requests once during rapid clicks and never caches a stream for reuse', async () => {
    const { capture, grant, getUserMedia, stream, stop } = setup()
    const first = capture.request({ audio: true })
    expect(await capture.request({ audio: true })).toBeUndefined()
    grant.resolve(stream)
    expect(await first).toBe(stream)
    expect(await capture.request({ audio: true })).toBeUndefined()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    capture.cancel()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(await capture.request({ audio: true })).toBeUndefined()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('stops every track from a permission grant after cancellation', async () => {
    const { capture, grant, stream, stop } = setup()
    const pending = capture.request({ video: true })
    capture.cancel()
    grant.resolve(stream)
    expect(await pending).toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('does not request after cancellation or report a late denial', async () => {
    const { capture, grant, getUserMedia } = setup()
    const pending = capture.request({ video: true })
    capture.cancel()
    grant.reject(new DOMException('Denied', 'NotAllowedError'))
    expect(await pending).toBeUndefined()
    expect(await capture.request({ audio: true })).toBeUndefined()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('does not retry denied permission automatically', async () => {
    const { capture, grant, getUserMedia } = setup()
    const pending = capture.request({ audio: true })
    grant.reject(new DOMException('Denied', 'NotAllowedError'))
    await expect(pending).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })
})

describe('permission guidance', () => {
  it('explains browser-controlled permission without querying or requesting it', () => {
    const { getUserMedia } = setup()
    expect(permissionGuidance('location')).toContain("this site's browser settings")
    expect(permissionGuidance('camera')).toContain('temporary grants or private browsing')
    expect(permissionGuidance('microphone')).toContain('cannot remember permission')
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('distinguishes blocked access from missing or busy hardware', () => {
    expect(mediaAccessError(new DOMException('Denied', 'NotAllowedError'), 'camera')).toContain('device settings')
    expect(mediaAccessError(new DOMException('Missing', 'NotFoundError'), 'microphone')).toContain('No microphone found')
    expect(mediaAccessError(new DOMException('Busy', 'NotReadableError'), 'camera')).toContain('Close other apps')
    expect(mediaAccessError(new Error('Cannot encrypt'), 'camera-and-microphone')).toBe('Cannot encrypt')
  })
})

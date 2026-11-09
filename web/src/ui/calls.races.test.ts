import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreClient } from '../core/client'
import { canEncryptCalls } from '../core/client'
import type { IncomingCallSignal } from '../core/protocol'
import { CallController, type CallState } from './calls'

vi.mock('../core/client', () => ({ canEncryptCalls: vi.fn(() => true), useEncodedStreams: () => false }))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function track(kind = 'video') {
  return { kind, enabled: true, stop: vi.fn(), addEventListener: vi.fn((_event: string, _callback: () => void) => undefined), getSettings: () => ({ deviceId: 'front' }) }
}
type Track = ReturnType<typeof track>
class Stream {
  constructor(private tracks: Track[]) {}
  getTracks() { return this.tracks }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video') }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio') }
  removeTrack(track: Track) { this.tracks = this.tracks.filter((t) => t !== track) }
  addTrack(track: Track) { this.tracks.push(track) }
}
function fixture(deferActivation = false) {
  const camera = track()
  const stream = new Stream([camera])
  const sender = { track: camera, replaceTrack: vi.fn(async (_track: Track): Promise<void> => undefined) }
  const pc = { getSenders: () => [sender], close: vi.fn() }
  const getDisplayMedia = vi.fn<() => Promise<Stream>>()
  const getUserMedia = vi.fn<() => Promise<Stream>>()
  const unsubscribe = vi.fn()
  const connection = new EventTarget()
  vi.stubGlobal('navigator', { connection, mediaDevices: {
    getDisplayMedia, getUserMedia,
    enumerateDevices: vi.fn(async () => [{ kind: 'videoinput', deviceId: 'front' }, { kind: 'videoinput', deviceId: 'back' }]),
  } })
  vi.stubGlobal('MediaStream', Stream)
  const core = {
    subscribe: vi.fn((_listener: (event: { type: 'call'; signal: IncomingCallSignal }) => void) => unsubscribe),
    callSignal: vi.fn(async (_id: string, _signal: { kind: string; callId: string }): Promise<void> => undefined),
    iceServers: vi.fn(async () => []), recordCall: vi.fn(),
  }
  const controller = new CallController(core as unknown as CoreClient, { deferActivation })
  const state: CallState = { callId: 'call', conversationId: 'chat', title: 'Contact', outgoing: true,
    phase: 'active', video: true, muted: false, cameraOff: false, cameras: 2 }
  return { controller, core, state, stream, camera, sender, pc, getDisplayMedia, getUserMedia, unsubscribe, connection }
}
function activeFixture() {
  const f = fixture()
  Object.assign(f.controller, { state: f.state, stream: f.stream, pc: f.pc })
  return f
}
async function settle() { for (let n = 0; n < 20; n++) await Promise.resolve() }
function setupSignalling(f: ReturnType<typeof fixture>) {
  vi.stubGlobal('RTCRtpReceiver', {})
  const pc = {
    ...f.pc, iceGatheringState: 'complete', localDescription: { sdp: 'synthetic-sdp' },
    getTransceivers: () => [],
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'synthetic-sdp' })),
    createAnswer: vi.fn(async () => ({ type: 'answer', sdp: 'synthetic-sdp' })),
    setLocalDescription: vi.fn(async () => undefined), setRemoteDescription: vi.fn(async () => undefined),
  }
  Object.assign(f.controller, { connect: (_servers: unknown, stream: Stream) => {
    Object.assign(f.controller, { pc, stream })
    return pc
  } })
  f.getUserMedia.mockImplementation(async () => new Stream([track('audio')]))
}
function timer(controller: CallController) { return (controller as unknown as { timer?: unknown }).timer }
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(canEncryptCalls).mockReturnValue(true)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('direct-call lifecycle activation', () => {
  it('defers subscriptions and restores them and network listeners after replay', async () => {
    const f = fixture(true)
    const online = vi.fn()
    const offline = vi.fn()
    vi.stubGlobal('addEventListener', online)
    vi.stubGlobal('removeEventListener', offline)
    const addConnection = vi.spyOn(f.connection, 'addEventListener')
    const removeConnection = vi.spyOn(f.connection, 'removeEventListener')
    expect(f.core.subscribe).not.toHaveBeenCalled()
    f.controller.activate()
    f.controller.activate()
    expect(f.core.subscribe).toHaveBeenCalledTimes(1)
    f.controller.deactivate()
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(offline).toHaveBeenCalledWith('online', online.mock.calls[0][1])
    expect(removeConnection).toHaveBeenCalledWith('change', addConnection.mock.calls[0][1])
    f.controller.activate()
    expect(f.core.subscribe).toHaveBeenCalledTimes(2)
    expect(online).toHaveBeenCalledTimes(2)
    vi.mocked(canEncryptCalls).mockReturnValue(false)
    await f.controller.start('chat', 'Contact', false)
    expect(f.controller.current()?.ended).toContain("can't encrypt call media")
    f.controller.dispose()
    expect(f.unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('stops active capture immediately during deactivation', () => {
    const f = activeFixture()
    f.core.callSignal.mockReturnValue(new Promise(() => {}))
    f.controller.deactivate()
    expect(f.camera.stop).toHaveBeenCalled()
    expect(f.controller.current()?.phase).toBe('ended')
    f.controller.activate()
    expect(f.controller.busy).toBe(false)
    f.controller.dispose()
  })
})

describe('screen capture races', () => {
  it('requests once and stops a late grant after hang-up without replacing the sender', async () => {
    const f = activeFixture()
    const capture = deferred<Stream>()
    f.getDisplayMedia.mockReturnValue(capture.promise)
    const first = f.controller.toggleScreenShare()
    await f.controller.toggleScreenShare()
    expect(f.getDisplayMedia).toHaveBeenCalledTimes(1)
    await f.controller.hangUp()
    const screen = track()
    capture.resolve(new Stream([screen]))
    await first
    expect(screen.stop).toHaveBeenCalled()
    expect(f.sender.replaceTrack).not.toHaveBeenCalled()
    expect(f.controller.current()?.phase).toBe('ended')
    f.controller.dispose()
  })

  it('stops capture immediately when hang-up occurs during sender replacement', async () => {
    const f = activeFixture()
    const screen = track()
    f.getDisplayMedia.mockResolvedValue(new Stream([screen]))
    const replaced = deferred<void>()
    f.sender.replaceTrack.mockReturnValue(replaced.promise)
    const sharing = f.controller.toggleScreenShare()
    await settle()
    expect(f.sender.replaceTrack).toHaveBeenCalledTimes(1)
    await f.controller.hangUp()
    expect(screen.stop).toHaveBeenCalled()
    // A late completion must not update a newer call.
    Object.assign(f.controller, { state: { ...f.state, callId: 'new-call' } })
    replaced.resolve()
    await sharing
    expect(f.controller.current()?.callId).toBe('new-call')
    expect(f.controller.current()?.sharing).toBeUndefined()
    f.controller.dispose()
  })

  it('releases a screen if replacement fails and permits an explicit retry', async () => {
    const f = activeFixture()
    const screen = track()
    f.getDisplayMedia.mockResolvedValue(new Stream([screen]))
    f.sender.replaceTrack.mockRejectedValueOnce(new Error('Replacement failed'))
    await expect(f.controller.toggleScreenShare()).rejects.toThrow('Replacement failed')
    expect(screen.stop).toHaveBeenCalled()
    await f.controller.toggleScreenShare()
    expect(f.getDisplayMedia).toHaveBeenCalledTimes(2)
    f.controller.dispose()
  })

  it('does not let an old screen-ended event change a newer call', async () => {
    const f = activeFixture()
    const screen = track()
    f.getDisplayMedia.mockResolvedValue(new Stream([screen]))
    await f.controller.toggleScreenShare()
    const ended = screen.addEventListener.mock.calls[0][1] as () => void
    await f.controller.hangUp()
    Object.assign(f.controller, { state: { ...f.state, callId: 'new-call', sharing: true } })
    ended()
    expect(f.sender.replaceTrack).toHaveBeenCalledTimes(1)
    expect(f.controller.current()?.sharing).toBe(true)
    f.controller.dispose()
  })
})

describe('camera privacy during replacement', () => {
  it('keeps a pending replacement disabled and reapplies Camera off after replaceTrack', async () => {
    const f = activeFixture()
    const replacement = track()
    const replaced = deferred<void>()
    f.getUserMedia.mockResolvedValue(new Stream([replacement]))
    f.sender.replaceTrack.mockReturnValue(replaced.promise)
    const switching = f.controller.switchCamera()
    await settle()
    expect(f.sender.replaceTrack).toHaveBeenCalledTimes(1)
    expect(replacement.enabled).toBe(false)
    f.controller.toggleCamera()
    expect(f.controller.current()?.cameraOff).toBe(true)
    replaced.resolve()
    await switching
    expect(replacement.enabled).toBe(false)
    expect(f.stream.getVideoTracks()).toEqual([replacement])
    f.controller.dispose()
  })

  it('enables the replacement only when current camera privacy permits it', async () => {
    const f = activeFixture()
    const replacement = track()
    f.getUserMedia.mockResolvedValue(new Stream([replacement]))
    await f.controller.switchCamera()
    expect(replacement.enabled).toBe(true)
    f.controller.dispose()
  })
})

describe('signalling completion timers', () => {
  for (const kind of ['offer', 'answer'] as const) {
    it(`does not let a late ${kind} completion replace a newer call timer`, async () => {
      const f = fixture()
      setupSignalling(f)
      const oldSignal = deferred<void>()
      let delay = true
      f.core.callSignal.mockImplementation(async (_id, signal) => {
        if (delay && signal.kind === kind) await oldSignal.promise
      })
      let old: Promise<void>
      if (kind === 'answer') {
        Object.assign(f.controller, { state: { ...f.state, outgoing: false, phase: 'incoming' },
          offer: { callId: 'call', conversationId: 'chat', sdp: 'synthetic-offer', fromDevice: 'peer' } })
        old = f.controller.accept(true)
      } else old = f.controller.start('chat', 'Contact', false)
      await settle()
      expect(f.core.callSignal).toHaveBeenCalledWith('chat', expect.objectContaining({ kind }))
      await f.controller.hangUp()
      delay = false
      await f.controller.start('chat', 'New contact', false)
      const newTimer = timer(f.controller)
      expect(newTimer).toBeDefined()
      oldSignal.resolve()
      await old
      expect(timer(f.controller)).toBe(newTimer)
      expect(f.controller.current()?.title).toBe('New contact')
      f.controller.dispose()
    })

    it(`does not install a ${kind} timeout after the same call becomes active`, async () => {
      const f = fixture()
      setupSignalling(f)
      const signal = deferred<void>()
      f.core.callSignal.mockImplementation(async (_id, action) => { if (action.kind === kind) await signal.promise })
      let starting: Promise<void>
      if (kind === 'answer') {
        Object.assign(f.controller, { state: { ...f.state, outgoing: false, phase: 'incoming' },
          offer: { callId: 'call', conversationId: 'chat', sdp: 'synthetic-offer', fromDevice: 'peer' } })
        starting = f.controller.accept(true)
      } else starting = f.controller.start('chat', 'Contact', false)
      await settle()
      expect(f.core.callSignal).toHaveBeenCalledWith('chat', expect.objectContaining({ kind }))
      Object.assign(f.controller, { state: { ...f.controller.current(), phase: 'active' } })
      signal.resolve()
      await starting
      expect(timer(f.controller)).toBeUndefined()
      f.controller.dispose()
    })
  }
})

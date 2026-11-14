import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreClient } from '../core/client'
import { canEncryptCalls } from '../core/client'
import { GroupCallController } from './groupCall'

const sdk = vi.hoisted(() => ({
  Room: vi.fn(),
  createLocalTracks: vi.fn(),
  createLocalScreenTracks: vi.fn(),
}))
vi.mock('livekit-client', () => ({
  ...sdk,
  Track: { Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen' }, Kind: { Video: 'video' } },
  RoomEvent: Object.fromEntries(['TrackSubscribed', 'TrackUnsubscribed', 'TrackMuted', 'TrackUnmuted',
    'ParticipantConnected', 'ParticipantDisconnected', 'ActiveSpeakersChanged', 'ConnectionQualityChanged',
    'Reconnecting', 'Disconnected'].map((name) => [name, name])),
  ConnectionQuality: { Poor: 'poor', Lost: 'lost' },
}))
vi.mock('../core/client', () => ({ canEncryptCalls: vi.fn(() => true), useEncodedStreams: () => false }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function track(kind = 'audio') {
  return {
    kind, sender: {}, mediaStreamTrack: { addEventListener: vi.fn() },
    stop: vi.fn(), mute: vi.fn(async (): Promise<void> => undefined), unmute: vi.fn(async (): Promise<void> => undefined),
  }
}
type FakeTrack = ReturnType<typeof track>
function fixture(options: { deferActivation?: boolean } = {}) {
  const publications = new Map<string, { track: FakeTrack; isMuted: boolean }>()
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const participant = {
    identity: 'local', trackPublications: publications,
    getTrackPublication: vi.fn((source: string) => publications.get(source)),
    publishTrack: vi.fn(async (local: FakeTrack, options?: { source: string }) => {
      const publication = { track: local, isMuted: false }
      publications.set(options?.source ?? (local.kind === 'video' ? 'camera' : 'microphone'), publication)
      return publication
    }),
    unpublishTrack: vi.fn(async () => undefined),
  }
  const room = {
    localParticipant: participant, remoteParticipants: new Map(), activeSpeakers: [],
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, handler); return room }),
    connect: vi.fn(async (): Promise<void> => undefined), disconnect: vi.fn(async (): Promise<void> => undefined),
    getActiveDevice: vi.fn(() => 'front'), switchActiveDevice: vi.fn(async () => undefined),
  }
  sdk.Room.mockImplementation(function () { return room })
  const microphone = track()
  sdk.createLocalTracks.mockResolvedValue([microphone])
  const unsubscribe = vi.fn()
  const core = {
    subscribe: vi.fn((_listener: unknown) => unsubscribe), callSignal: vi.fn(async (): Promise<void> => undefined),
    groupCallJoin: vi.fn(async () => ({ url: 'wss://fixture.invalid', token: 'synthetic' })),
    deviceNames: vi.fn(async () => ({})), protectMedia: vi.fn(), recordCall: vi.fn(),
  }
  const controller = new GroupCallController(core as unknown as CoreClient, options)
  return { controller, core, room, participant, publications, handlers, microphone, unsubscribe }
}
async function settle() {
  // Flush promise continuations without adding a real-time delay.
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(canEncryptCalls).mockReturnValue(true)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('group call capture lifecycle', () => {
  it('defers subscriptions and restores a retained controller after StrictMode lifecycle replay', async () => {
    const { controller, core, unsubscribe } = fixture({ deferActivation: true })
    expect(core.subscribe).not.toHaveBeenCalled()
    controller.activate()
    controller.activate()
    expect(core.subscribe).toHaveBeenCalledTimes(1)
    controller.deactivate()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    controller.activate()
    expect(core.subscribe).toHaveBeenCalledTimes(2)
    vi.mocked(canEncryptCalls).mockReturnValue(false)
    await controller.join('chat', 'call', 'Group', false)
    expect(controller.current()?.ended).toContain("can't encrypt call media")
    controller.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('stops capture immediately on deactivation and supports a later activation', async () => {
    const { controller, microphone, room } = fixture()
    await controller.join('chat', 'call', 'Group', false)
    room.disconnect.mockReturnValue(new Promise(() => {}))
    controller.deactivate()
    expect(microphone.stop).toHaveBeenCalled()
    expect(controller.current()).toBeUndefined()
    controller.activate()
    await controller.join('chat', 'new-call', 'Group', false)
    expect(controller.current()?.phase).toBe('active')
    controller.dispose()
  })

  it('does not join after cancellation while the initial signal waits', async () => {
    const { controller, core } = fixture()
    const signal = deferred<void>()
    core.callSignal.mockReturnValue(signal.promise)
    const starting = controller.start('chat', 'Group', true)
    await controller.leave()
    signal.resolve()
    await starting
    expect(core.groupCallJoin).not.toHaveBeenCalled()
    expect(sdk.createLocalTracks).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('does not request capture after cancellation during token loading', async () => {
    const { controller, core } = fixture()
    const token = deferred<{ url: string; token: string }>()
    core.groupCallJoin.mockReturnValue(token.promise)
    const joining = controller.join('chat', 'call', 'Group', true)
    await controller.leave()
    token.resolve({ url: 'wss://fixture.invalid', token: 'synthetic' })
    await joining
    expect(core.deviceNames).not.toHaveBeenCalled()
    expect(sdk.createLocalTracks).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('invalidates a pending join on disposal', async () => {
    const { controller, core } = fixture()
    const names = deferred<Record<string, string>>()
    core.deviceNames.mockReturnValue(names.promise)
    const joining = controller.join('chat', 'call', 'Group', true)
    await settle()
    controller.dispose()
    names.resolve({})
    await joining
    expect(sdk.createLocalTracks).not.toHaveBeenCalled()
    expect(controller.current()).toBeUndefined()
  })

  it('does not capture after cancellation while the SDK connects', async () => {
    const { controller, room } = fixture()
    const connection = deferred<void>()
    room.connect.mockReturnValue(connection.promise)
    const joining = controller.join('chat', 'call', 'Group', true)
    await settle()
    expect(room.connect).toHaveBeenCalledTimes(1)
    await controller.leave()
    connection.resolve()
    await joining
    expect(sdk.createLocalTracks).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('stops late grants and blocks device actions during the initial capture', async () => {
    const { controller, participant } = fixture()
    const capture = deferred<FakeTrack[]>()
    sdk.createLocalTracks.mockReturnValue(capture.promise)
    const joining = controller.join('chat', 'call', 'Group', true)
    await settle()
    expect(sdk.createLocalTracks).toHaveBeenCalledTimes(1)
    await Promise.all([controller.toggleMute(), controller.toggleCamera()])
    expect(sdk.createLocalTracks).toHaveBeenCalledTimes(1)
    await controller.leave()
    const camera = track('video')
    capture.resolve([camera])
    await joining
    expect(camera.stop).toHaveBeenCalled()
    expect(participant.publishTrack).not.toHaveBeenCalled()
    expect(controller.current()?.phase).toBe('ended')
    controller.dispose()
  })

  it('never unmutes tracks without an encrypted sender and releases failed capture', async () => {
    const { controller, participant, microphone, core } = fixture()
    participant.publishTrack.mockResolvedValue({ track: { ...microphone, sender: undefined } as unknown as FakeTrack, isMuted: false })
    await controller.join('chat', 'call', 'Group', false)
    expect(microphone.stop).toHaveBeenCalled()
    expect(microphone.unmute).not.toHaveBeenCalled()
    expect(core.protectMedia).not.toHaveBeenCalled()
    expect(controller.current()?.ended).toContain("can't be encrypted")
    controller.dispose()
  })

  it('cancels publication before an awaited mute can finish', async () => {
    const { controller, microphone, participant } = fixture()
    const muted = deferred<void>()
    microphone.mute.mockReturnValue(muted.promise)
    const joining = controller.join('chat', 'call', 'Group', false)
    await settle()
    await controller.leave()
    expect(microphone.stop).toHaveBeenCalled()
    muted.resolve()
    await joining
    expect(participant.publishTrack).not.toHaveBeenCalled()
    expect(microphone.unmute).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('protects each sender before unmuting', async () => {
    const { controller, core, microphone } = fixture()
    await controller.join('chat', 'call', 'Group', false)
    expect(core.protectMedia).toHaveBeenCalledWith(microphone.sender, expect.objectContaining({ direction: 'send', kind: 'audio' }))
    expect(core.protectMedia.mock.invocationCallOrder[0]).toBeLessThan(microphone.unmute.mock.invocationCallOrder[0])
    controller.dispose()
    expect(microphone.stop).toHaveBeenCalled()
  })

  it('serializes microphone changes and never revives an ended call', async () => {
    const { controller, microphone } = fixture()
    await controller.join('chat', 'call', 'Group', false)
    const muted = deferred<void>()
    microphone.mute.mockClear().mockReturnValue(muted.promise)
    const first = controller.toggleMute()
    await controller.toggleMute()
    expect(microphone.mute).toHaveBeenCalledTimes(1)
    await controller.leave()
    muted.resolve()
    await first
    expect(controller.current()?.phase).toBe('ended')
    controller.dispose()
  })

  it('serializes camera actions and stops a late optional-camera grant', async () => {
    const { controller, participant } = fixture()
    await controller.join('chat', 'call', 'Group', false)
    sdk.createLocalTracks.mockClear()
    participant.publishTrack.mockClear()
    const capture = deferred<FakeTrack[]>()
    sdk.createLocalTracks.mockReturnValue(capture.promise)
    const first = controller.toggleCamera()
    await Promise.all([controller.toggleCamera(), controller.switchCamera()])
    expect(sdk.createLocalTracks).toHaveBeenCalledTimes(1)
    await controller.leave()
    const camera = track('video')
    capture.resolve([camera])
    await first
    expect(camera.stop).toHaveBeenCalled()
    expect(participant.publishTrack).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('stops a late screen grant without publishing or retrying', async () => {
    const { controller, participant } = fixture()
    await controller.join('chat', 'call', 'Group', false)
    participant.publishTrack.mockClear()
    const capture = deferred<FakeTrack[]>()
    sdk.createLocalScreenTracks.mockReturnValue(capture.promise)
    const first = controller.toggleScreenShare()
    await controller.toggleScreenShare()
    expect(sdk.createLocalScreenTracks).toHaveBeenCalledTimes(1)
    await controller.leave()
    const screen = track('video')
    capture.resolve([screen])
    await first
    expect(screen.stop).toHaveBeenCalled()
    expect(participant.publishTrack).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('ignores an old join failure after a new call starts', async () => {
    const { controller, core } = fixture()
    const old = deferred<{ url: string; token: string }>()
    core.groupCallJoin.mockReturnValueOnce(old.promise)
    const first = controller.join('chat', 'old', 'Group', false)
    await controller.leave()
    await controller.join('chat', 'new', 'Group', false)
    expect(controller.current()?.callId).toBe('new')
    old.reject(new Error('Old connection failed'))
    await first
    expect(controller.current()?.phase).toBe('active')
    expect(controller.current()?.callId).toBe('new')
    controller.dispose()
  })

  it('stops a late SDK restart even after the SDK clears publications', async () => {
    const { controller, microphone, publications } = fixture()
    await controller.join('chat', 'call', 'Group', false)
    await controller.toggleMute()
    const unmuted = deferred<void>()
    microphone.unmute.mockReturnValue(unmuted.promise)
    const resuming = controller.toggleMute()
    await controller.leave()
    publications.clear()
    microphone.stop.mockClear()
    unmuted.resolve()
    await resuming
    expect(microphone.stop).toHaveBeenCalled()
    expect(controller.current()?.phase).toBe('ended')
    controller.dispose()
  })

  it('does not switch cameras after leaving during enumeration', async () => {
    const { controller, room } = fixture()
    await controller.join('chat', 'call', 'Group', true)
    const cameras = deferred<MediaDeviceInfo[]>()
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: vi.fn(() => cameras.promise) } })
    const switching = controller.switchCamera()
    await controller.leave()
    cameras.resolve([{ kind: 'videoinput', deviceId: 'front' }, { kind: 'videoinput', deviceId: 'back' }] as MediaDeviceInfo[])
    await switching
    expect(room.switchActiveDevice).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps the encrypted-media capability guard before token loading and capture', async () => {
    const { controller, core } = fixture()
    vi.mocked(canEncryptCalls).mockReturnValue(false)
    await controller.join('chat', 'call', 'Group', true)
    expect(core.groupCallJoin).not.toHaveBeenCalled()
    expect(sdk.createLocalTracks).not.toHaveBeenCalled()
    expect(controller.current()?.ended).toContain("can't encrypt call media")
    controller.dispose()
  })
})

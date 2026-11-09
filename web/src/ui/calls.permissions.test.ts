import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreClient } from '../core/client'
import { canEncryptCalls } from '../core/client'
import type { IceServer } from '../core/protocol'
import { CallController } from './calls'

vi.mock('../core/client', () => ({
  canEncryptCalls: vi.fn(() => true),
  useEncodedStreams: () => false,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function fixture() {
  const ice = deferred<IceServer[]>()
  const signalling = deferred<void>()
  const getUserMedia = vi.fn<() => Promise<MediaStream>>()
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  const core = {
    subscribe: vi.fn(() => () => undefined),
    iceServers: vi.fn(() => ice.promise),
    callSignal: vi.fn(() => signalling.promise),
    recordCall: vi.fn(),
  }
  const controller = new CallController(core as unknown as CoreClient)
  return { controller, core, ice, signalling, getUserMedia }
}

function activeCameraFixture() {
  const fixtureState = fixture()
  const stop = vi.fn()
  const track = { kind: 'video', stop, getSettings: () => ({ deviceId: 'front' }) }
  const stream = {
    getTracks: () => [track],
    removeTrack: vi.fn(),
    addTrack: vi.fn(),
  }
  const sender = { track, replaceTrack: vi.fn(async () => undefined) }
  // Seed an active encrypted call. These tests concern capture lifecycle, not transport.
  Object.assign(fixtureState.controller, {
    state: { callId: 'call', conversationId: 'conversation', phase: 'active' },
    stream,
    pc: { getSenders: () => [sender], close: vi.fn() },
  })
  const enumerate = deferred<MediaDeviceInfo[]>()
  Object.assign(navigator.mediaDevices, { enumerateDevices: vi.fn(() => enumerate.promise) })
  const cameras = [{ kind: 'videoinput', deviceId: 'front' }, { kind: 'videoinput', deviceId: 'back' }] as MediaDeviceInfo[]
  return { ...fixtureState, enumerate, cameras, sender, stop }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(canEncryptCalls).mockReturnValue(true)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('call permission lifecycle', () => {
  it('does not ask for media after cancellation while relay settings load', async () => {
    const { controller, ice, signalling, getUserMedia } = fixture()
    const starting = controller.start('conversation', 'Contact', true)
    const ending = controller.hangUp()
    expect(controller.current()?.phase).toBe('ended')
    ice.resolve([])
    await starting
    expect(getUserMedia).not.toHaveBeenCalled()
    signalling.resolve()
    await ending
    controller.dispose()
  })

  it('stops a late grant without waiting for hang-up signalling', async () => {
    const { controller, ice, signalling, getUserMedia } = fixture()
    const grant = deferred<MediaStream>()
    getUserMedia.mockReturnValue(grant.promise)
    const starting = controller.start('conversation', 'Contact', false)
    ice.resolve([])
    await Promise.resolve()
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false })
    const ending = controller.hangUp()
    const stop = vi.fn()
    grant.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    await starting
    expect(stop).toHaveBeenCalledTimes(1)
    expect(controller.current()?.phase).toBe('ended')
    signalling.resolve()
    await ending
    controller.dispose()
  })

  it('rejects a second call before it can request media', async () => {
    const { controller, ice, signalling, getUserMedia, core } = fixture()
    const starting = controller.start('conversation', 'Contact', true)
    await expect(controller.start('conversation', 'Contact', true)).rejects.toThrow('already in a call')
    expect(core.iceServers).toHaveBeenCalledTimes(1)
    const ending = controller.hangUp()
    ice.resolve([])
    signalling.resolve()
    await Promise.all([starting, ending])
    expect(getUserMedia).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('does not request another camera after hang-up during enumeration', async () => {
    const { controller, enumerate, cameras, getUserMedia, signalling } = activeCameraFixture()
    const switching = controller.switchCamera()
    const ending = controller.hangUp()
    enumerate.resolve(cameras)
    await switching
    expect(getUserMedia).not.toHaveBeenCalled()
    signalling.resolve()
    await ending
    controller.dispose()
  })

  it('serializes camera switches and stops a late replacement after hang-up', async () => {
    const { controller, enumerate, cameras, getUserMedia, signalling, sender } = activeCameraFixture()
    const grant = deferred<MediaStream>()
    getUserMedia.mockReturnValue(grant.promise)
    const first = controller.switchCamera()
    await controller.switchCamera()
    enumerate.resolve(cameras)
    await Promise.resolve()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    const ending = controller.hangUp()
    const stop = vi.fn()
    grant.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    await first
    expect(stop).toHaveBeenCalledTimes(1)
    expect(sender.replaceTrack).not.toHaveBeenCalled()
    signalling.resolve()
    await ending
    controller.dispose()
  })

  it('keeps the encrypted-media capability guard before any media request', async () => {
    const { controller, core, getUserMedia } = fixture()
    vi.mocked(canEncryptCalls).mockReturnValue(false)
    await controller.start('conversation', 'Contact', true)
    expect(controller.current()?.ended).toContain("can't encrypt call media")
    expect(core.iceServers).not.toHaveBeenCalled()
    expect(getUserMedia).not.toHaveBeenCalled()
    controller.dispose()
  })
})

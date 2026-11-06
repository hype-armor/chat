// Group calls through LiveKit (ADR-0031). LiveKit's client runs the peer
// connections; every encoded frame still goes through the core worker for
// SFrame (ADR-0030), like 1:1 calls, so LiveKit forwards frames it can't
// read. LiveKit's own end-to-end encryption is not used.
import type { LocalTrack, Participant, RemoteTrack, Room } from 'livekit-client'

/** LiveKit's client, loaded when a group call starts (it is large). */
type LiveKit = typeof import('livekit-client')
import { type CoreClient, canEncryptCalls, useEncodedStreams } from '../core/client'
import type { IncomingCallSignal } from '../core/protocol'

/** Video tiles shown at once (FR-CALL-6); everyone else is listed by name. */
export const MAX_VIDEO_TILES = 16
/** A group call's "join?" prompt goes away after this long. */
const PROMPT_MS = 45_000

export type Tile = {
  id: string
  /** A shared screen rather than a person's camera. */
  screen?: boolean
  name: string
  local: boolean
  video?: MediaStreamTrack
  audio?: MediaStreamTrack
  speaking: boolean
  muted: boolean
}

export type GroupCallState = {
  conversationId: string
  callId: string
  title: string
  video: boolean
  phase: 'incoming' | 'joining' | 'active' | 'ended'
  ended?: string
  muted: boolean
  cameraOff: boolean
  tiles: Tile[]
  /** LiveKit's rating of this device's connection (FR-CALL-8). */
  quality?: 'good' | 'poor'
  sharing?: boolean
}

function randomCallId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The call ids this page uses. The SFrame keys of a call come from its call id
 * and the MLS epoch, and a new key state starts its frame counter at 0, so one
 * call id must keep one key state (audit M10). A call that starts here takes an
 * id this page has not used yet; a rejoin keeps the id of the call it rejoins,
 * so the core keeps the keys and the counter it already has.
 */
export class CallIds {
  private readonly used = new Set<string>()

  constructor(private readonly random: () => string = randomCallId) {}

  /** An id for a call that starts here, never one this page has used. */
  start(): string {
    let id = this.random()
    // A source that repeats must not hand out an id that already has keys.
    if (this.used.has(id)) id = randomCallId()
    this.used.add(id)
    return id
  }

  /** The id a join runs under: the call already has it, so its keys stay. */
  rejoin(offered: string): string {
    this.used.add(offered)
    return offered
  }

  /** Whether this page has joined a call with this id. */
  joined(id: string): boolean {
    return this.used.has(id)
  }
}

const NO_FRAME_ENCRYPTION =
  "This browser can't encrypt call media end to end, so calls are off. Use an up-to-date Chrome, Firefox or Safari."

export class GroupCallController {
  private state?: GroupCallState
  private listeners = new Set<() => void>()
  private room?: Room
  private lk?: LiveKit
  private names: Record<string, string> = {}
  private timer?: ReturnType<typeof setTimeout>
  private unsubscribe: () => void
  private readonly callIds = new CallIds()
  /** Another call (1:1) is running here. */
  otherBusy: () => boolean = () => false

  constructor(private readonly core: CoreClient) {
    this.unsubscribe = core.subscribe((e) => {
      if (e.type === 'call' && e.signal.group) this.onStarted(e.signal)
    })
  }

  dispose() {
    this.unsubscribe()
    void this.room?.disconnect()
  }

  current(): GroupCallState | undefined {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get busy(): boolean {
    return !!this.state && this.state.phase !== 'ended' && this.state.phase !== 'incoming'
  }

  /** Starts a call in a group: tells the members, then joins its room. */
  async start(conversationId: string, title: string, video: boolean) {
    if (this.busy || this.otherBusy()) throw new Error("You're already in a call")
    const callId = this.callIds.start()
    this.show({ conversationId, callId, title, video, phase: 'joining' })
    try {
      if (!canEncryptCalls()) throw new Error(NO_FRAME_ENCRYPTION)
      await this.core.callSignal(conversationId, { callId, kind: 'offer', group: true, video })
      await this.connect(video)
    } catch (e) {
      if (canEncryptCalls()) this.core.recordCall('group', false)
      this.finish(e instanceof Error ? e.message : String(e))
    }
  }

  /** Joins a call already going in a group. */
  async join(conversationId: string, offered: string, title: string, video: boolean) {
    if (this.busy || this.otherBusy()) throw new Error("You're already in a call")
    // The call id stays: its keys and their frame counter stay in the core
    // worker too (audit M10).
    const callId = this.callIds.rejoin(offered)
    this.show({ conversationId, callId, title, video, phase: 'joining' })
    try {
      if (!canEncryptCalls()) throw new Error(NO_FRAME_ENCRYPTION)
      await this.connect(video)
    } catch (e) {
      if (canEncryptCalls()) this.core.recordCall('group', false)
      this.finish(e instanceof Error ? e.message : String(e))
    }
  }

  /** Joins the call the prompt is about. */
  async accept(video: boolean) {
    const s = this.state
    if (s?.phase !== 'incoming') return
    clearTimeout(this.timer)
    await this.join(s.conversationId, s.callId, s.title, s.video && video)
  }

  dismiss() {
    if (this.state?.phase === 'incoming' || this.state?.phase === 'ended') this.set(undefined)
  }

  async leave() {
    await this.room?.disconnect()
    this.finish('You left the call')
  }

  async toggleMute() {
    const s = this.state
    if (!s || !this.room) return
    await this.room.localParticipant.setMicrophoneEnabled(s.muted)
    this.set({ ...s, muted: !s.muted })
  }

  async toggleCamera() {
    const s = this.state
    const lk = this.lk
    if (!s || !this.room || !lk) return
    const pub = this.room.localParticipant.getTrackPublication(lk.Track.Source.Camera)
    if (pub?.track) {
      if (s.cameraOff) await pub.track.unmute()
      else await pub.track.mute()
    } else {
      await this.publish(await lk.createLocalTracks({ video: true, audio: false }))
    }
    this.set({ ...this.state!, cameraOff: !s.cameraOff })
    this.refresh()
  }

  /** Next camera; LiveKit swaps the track on the same (encrypted) sender. */
  async switchCamera() {
    const room = this.room
    if (!room) return
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
    if (cameras.length < 2) return
    const current = room.getActiveDevice('videoinput')
    const at = cameras.findIndex((d) => d.deviceId === current)
    await room.switchActiveDevice('videoinput', cameras[(at + 1) % cameras.length].deviceId)
    this.refresh()
  }

  /** Shares the screen as its own track (FR-CALL-7), encrypted like the others. */
  async toggleScreenShare() {
    const room = this.room
    const lk = this.lk
    const s = this.state
    if (!room || !lk || !s) return
    const pub = room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShare)
    if (pub?.track) {
      await room.localParticipant.unpublishTrack(pub.track)
      this.set({ ...this.state!, sharing: false })
    } else {
      let tracks: LocalTrack[]
      try {
        tracks = await lk.createLocalScreenTracks({ audio: false })
      } catch {
        return // cancelled
      }
      for (const t of tracks) {
        t.mediaStreamTrack.addEventListener('ended', () => this.state?.sharing && void this.toggleScreenShare())
      }
      await this.publish(tracks, lk.Track.Source.ScreenShare)
      this.set({ ...this.state!, sharing: true })
    }
    this.refresh()
  }

  async setSpeaker(deviceId: string) {
    await this.room?.switchActiveDevice('audiooutput', deviceId)
  }

  private onStarted(s: IncomingCallSignal) {
    if (this.busy || this.otherBusy() || s.elsewhere) return
    this.show({ conversationId: s.conversationId, callId: s.callId, title: s.title, video: !!s.video, phase: 'incoming' })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.state?.phase === 'incoming' && this.set(undefined), PROMPT_MS)
  }

  private async connect(video: boolean) {
    const s = this.state!
    const started = Date.now()
    const { url, token } = await this.core.groupCallJoin(s.conversationId, s.callId)
    this.names = await this.core.deviceNames(s.conversationId)
    const lk = (this.lk ??= await import('livekit-client'))
    const { RoomEvent, Track } = lk
    const room = new lk.Room({
      adaptiveStream: true,
      dynacast: true,
      // VP8 for SFrame's clear-header rule (ADR-0030); RED would wrap
      // encrypted audio in a way receivers can't take apart.
      publishDefaults: { videoCodec: 'vp8', red: false, simulcast: true },
    })
    this.room = room
    const update = () => this.refresh()
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.receiver) this.protect(track.receiver, 'receive', track.kind === Track.Kind.Video ? 'video' : 'audio')
        update()
      })
      .on(RoomEvent.TrackUnsubscribed, update)
      .on(RoomEvent.TrackMuted, update)
      .on(RoomEvent.TrackUnmuted, update)
      .on(RoomEvent.ParticipantConnected, update)
      .on(RoomEvent.ParticipantDisconnected, update)
      .on(RoomEvent.ActiveSpeakersChanged, update)
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant !== room.localParticipant || !this.state) return
        const poor = quality === lk.ConnectionQuality.Poor || quality === lk.ConnectionQuality.Lost
        this.set({ ...this.state, quality: poor ? 'poor' : 'good' })
      })
      .on(RoomEvent.Reconnecting, () => this.state && this.set({ ...this.state, quality: 'poor' }))
      .on(RoomEvent.Disconnected, () => this.state?.phase === 'active' && this.finish('Call ended'))
    // Chromium: no frame moves until our encoded streams are taken.
    const rtcConfig = useEncodedStreams()
      ? ({ encodedInsertableStreams: true } as RTCConfiguration)
      : undefined
    await room.connect(url, token, { autoSubscribe: true, rtcConfig })
    if (this.room !== room) return void room.disconnect()
    this.set({ ...this.state!, phase: 'active', cameraOff: !video })
    await this.publish(await lk.createLocalTracks({ audio: true, video }))
    this.core.recordCall('group', true, Date.now() - started)
    this.refresh()
  }

  /**
   * Publishes tracks muted, puts their senders through SFrame, then
   * unmutes: frames sent before the transform is attached are only
   * silence and black (RTCRtpScriptTransform can only be set on a sender
   * that exists).
   */
  private async publish(tracks: LocalTrack[], source?: import('livekit-client').Track.Source) {
    const room = this.room!
    for (const track of tracks) {
      await track.mute()
      const pub = await room.localParticipant.publishTrack(track, source ? { source } : undefined)
      const sender = pub.track?.sender
      if (!sender) throw new Error("The call can't be encrypted")
      this.protect(sender, 'send', track.kind === 'video' ? 'video' : 'audio')
      await track.unmute()
    }
  }

  private protect(target: RTCRtpSender | RTCRtpReceiver, direction: 'send' | 'receive', kind: 'audio' | 'video') {
    const { conversationId, callId } = this.state!
    this.core.protectMedia(target, { conversationId, callId, direction, kind })
  }

  /** Rebuilds the tiles from the room. */
  private refresh() {
    const room = this.room
    const s = this.state
    const Track = this.lk?.Track
    if (!room || !s || !Track) return
    const speaking = new Set(room.activeSpeakers.map((p) => p.identity))
    const tile = (p: Participant, local: boolean): Tile => {
      const camera = p.getTrackPublication(Track.Source.Camera)
      const mic = p.getTrackPublication(Track.Source.Microphone)
      return {
        id: p.identity,
        name: local ? 'You' : (this.names[p.identity] ?? 'Someone'),
        local,
        video: camera && !camera.isMuted ? camera.track?.mediaStreamTrack : undefined,
        audio: local ? undefined : mic?.track?.mediaStreamTrack,
        speaking: speaking.has(p.identity),
        muted: !mic || mic.isMuted,
      }
    }
    const screen = (p: Participant, local: boolean): Tile[] => {
      const share = p.getTrackPublication(Track.Source.ScreenShare)
      const video = share && !share.isMuted ? share.track?.mediaStreamTrack : undefined
      if (!video) return []
      const name = local ? 'You' : (this.names[p.identity] ?? 'Someone')
      return [{ id: `${p.identity}:screen`, screen: true, name: `${name} (screen)`, local, video, speaking: false, muted: true }]
    }
    const everyone: [Participant, boolean][] = [
      [room.localParticipant, true],
      ...[...room.remoteParticipants.values()].map((p): [Participant, boolean] => [p, false]),
    ]
    // Shared screens first: they are what people are looking at.
    const tiles = [...everyone.flatMap(([p, l]) => screen(p, l)), ...everyone.map(([p, l]) => tile(p, l))]
    this.set({ ...s, tiles })
  }

  private show(s: Omit<GroupCallState, 'muted' | 'cameraOff' | 'tiles'>) {
    this.set({ ...s, muted: false, cameraOff: !s.video, tiles: [] })
  }

  private finish(reason: string) {
    clearTimeout(this.timer)
    const room = this.room
    this.room = undefined
    void room?.disconnect()
    if (!this.state) return
    const callId = this.state.callId
    this.set({ ...this.state, phase: 'ended', ended: reason, tiles: [] })
    setTimeout(() => this.state?.callId === callId && this.state.phase === 'ended' && this.set(undefined), 2_500)
  }

  private set(state: GroupCallState | undefined) {
    this.state = state
    for (const l of this.listeners) l()
  }
}

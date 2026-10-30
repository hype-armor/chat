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
}

function randomCallId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
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
    const callId = randomCallId()
    this.show({ conversationId, callId, title, video, phase: 'joining' })
    try {
      if (!canEncryptCalls()) throw new Error(NO_FRAME_ENCRYPTION)
      await this.core.callSignal(conversationId, { callId, kind: 'offer', group: true, video })
      await this.connect(video)
    } catch (e) {
      this.finish(e instanceof Error ? e.message : String(e))
    }
  }

  /** Joins a call already going in a group. */
  async join(conversationId: string, callId: string, title: string, video: boolean) {
    if (this.busy || this.otherBusy()) throw new Error("You're already in a call")
    this.show({ conversationId, callId, title, video, phase: 'joining' })
    try {
      if (!canEncryptCalls()) throw new Error(NO_FRAME_ENCRYPTION)
      await this.connect(video)
    } catch (e) {
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

  private onStarted(s: IncomingCallSignal) {
    if (this.busy || this.otherBusy() || s.elsewhere) return
    this.show({ conversationId: s.conversationId, callId: s.callId, title: s.title, video: !!s.video, phase: 'incoming' })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.state?.phase === 'incoming' && this.set(undefined), PROMPT_MS)
  }

  private async connect(video: boolean) {
    const s = this.state!
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
      .on(RoomEvent.Disconnected, () => this.state?.phase === 'active' && this.finish('Call ended'))
    // Chromium: no frame moves until our encoded streams are taken.
    const rtcConfig = useEncodedStreams()
      ? ({ encodedInsertableStreams: true } as RTCConfiguration)
      : undefined
    await room.connect(url, token, { autoSubscribe: true, rtcConfig })
    if (this.room !== room) return void room.disconnect()
    this.set({ ...this.state!, phase: 'active', cameraOff: !video })
    await this.publish(await lk.createLocalTracks({ audio: true, video }))
    this.refresh()
  }

  /**
   * Publishes tracks muted, puts their senders through SFrame, then
   * unmutes: frames sent before the transform is attached are only
   * silence and black (RTCRtpScriptTransform can only be set on a sender
   * that exists).
   */
  private async publish(tracks: LocalTrack[]) {
    const room = this.room!
    for (const track of tracks) {
      await track.mute()
      const pub = await room.localParticipant.publishTrack(track)
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
    const tiles = [tile(room.localParticipant, true), ...[...room.remoteParticipants.values()].map((p) => tile(p, false))]
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

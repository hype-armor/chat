// The call screen's engine (ADR-0028). RTCPeerConnection and the camera
// exist only on the page, so media runs here; every signal goes through
// the core worker, which encrypts it as an MLS message. Keys never come
// here: DTLS-SRTP keys are negotiated by the browser, the fingerprints
// that pin them travel end-to-end encrypted inside the SDP, and every
// encoded frame also goes through the core worker for SFrame (ADR-0030).
import { type CoreClient, canEncryptCalls, useEncodedStreams } from '../core/client'
import type { IceServer, IncomingCallSignal } from '../core/protocol'
import { RING_MS } from '../core/calls'
import { type Quality, VIDEO_BITRATE, measure, rate } from './quality'

export type CallPhase = 'incoming' | 'calling' | 'connecting' | 'active' | 'ended'

export type CallState = {
  callId: string
  conversationId: string
  title: string
  /** A video call (the offer asked for video). */
  video: boolean
  outgoing: boolean
  phase: CallPhase
  /** Why it ended, for the closing screen. */
  ended?: string
  connectedAt?: number
  muted: boolean
  cameraOff: boolean
  local?: MediaStream
  remote?: MediaStream
  /** From WebRTC stats while active (FR-CALL-8). */
  quality?: Quality
  /** Cameras on this device; switching needs two. */
  cameras: number
  /** Chosen audio output (`setSinkId`), if any. */
  speaker?: string
  /** Showing the screen instead of the camera (FR-CALL-7). */
  sharing?: boolean
}

/** Media needs a connection within this long once answered. */
const CONNECT_MS = 30_000
/** A dropped connection that doesn't come back (after ICE restarts) ends the call. */
const RECONNECT_MS = 25_000
/** A connection still "disconnected" after this gets an ICE restart. */
const RESTART_AFTER_MS = 2_000
const STATS_EVERY_MS = 3_000
/** How long the closing screen stays. */
const ENDED_MS = 2_500
/** Candidates gathered by then go inside the offer or answer; later ones trickle. */
const GATHER_MS = 2_000

function randomCallId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const NO_FRAME_ENCRYPTION =
  "This browser can't encrypt call media end to end, so calls are off. Use an up-to-date Chrome, Firefox or Safari."

/** Video as VP8 only: SFrame leaves exactly its payload header readable (ADR-0030). */
function preferVp8(pc: RTCPeerConnection) {
  const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs
  if (!codecs) return
  const vp8 = codecs.filter((c) => /^video\/(vp8|rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType))
  for (const t of pc.getTransceivers()) {
    if (t.receiver.track.kind === 'video' && t.setCodecPreferences) t.setCodecPreferences(vp8)
  }
}

/** Resolves once ICE gathering completes, or after `ms`. */
function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const done = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => pc.iceGatheringState === 'complete' && done()
    const timer = setTimeout(done, ms)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

function mediaError(e: unknown, video: boolean): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError') return video ? 'Allow the camera and microphone to call' : 'Allow the microphone to call'
  if (name === 'NotFoundError') return video ? 'No camera or microphone found' : 'No microphone found'
  return e instanceof Error ? e.message : String(e)
}

export class CallController {
  private state?: CallState
  private listeners = new Set<() => void>()
  private pc?: RTCPeerConnection
  private stream?: MediaStream
  /** The other side's device (hex), once known. */
  private peerDevice?: string
  private offer?: IncomingCallSignal
  /** Ours, gathered after the description went out, until the peer's device is known. */
  private ownCandidates: string[] = []
  /** Theirs, until their description is applied. */
  private theirCandidates: RTCIceCandidateInit[] = []
  private described = false
  private timer?: ReturnType<typeof setTimeout>
  private dropTimer?: ReturnType<typeof setTimeout>
  private restartTimer?: ReturnType<typeof setTimeout>
  private statsTimer?: ReturnType<typeof setInterval>
  /** An ICE restart offer is out (caller only). */
  private restarting = false
  /** When the call was answered (setup starts), for the opt-in statistics. */
  private setupFrom?: number
  private unsubscribe: () => void
  /** A group call is running here. */
  otherBusy: () => boolean = () => false
  /** Only relayed candidates, so the other side never learns this device's address (FR-CALL-9). */
  relayOnly = false

  constructor(private readonly core: CoreClient) {
    this.unsubscribe = core.subscribe((e) => {
      if (e.type === 'call') void this.onSignal(e.signal).catch((err) => console.warn('call signal failed', err))
    })
    // A new network (Wi-Fi to mobile data): find a new path at once.
    const moved = () => this.state?.phase === 'active' && void this.restartIce()
    globalThis.addEventListener?.('online', moved)
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection
    connection?.addEventListener('change', moved)
  }

  dispose() {
    this.unsubscribe()
    if (this.state && this.state.phase !== 'ended') void this.hangUp()
  }

  current(): CallState | undefined {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Busy with a call (an ended call's closing screen doesn't count). */
  get busy(): boolean {
    return !!this.state && this.state.phase !== 'ended'
  }

  /** Calls the other person in a 1:1 conversation. */
  async start(conversationId: string, title: string, video: boolean) {
    if (this.busy || this.otherBusy()) throw new Error("You're already in a call")
    const callId = randomCallId()
    this.reset()
    this.set({ callId, conversationId, title, video, outgoing: true, phase: 'calling', muted: false, cameraOff: false, cameras: 0 })
    try {
      if (!canEncryptCalls()) throw new Error(NO_FRAME_ENCRYPTION)
      const servers = this.checkRelay(await this.core.iceServers())
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video })
      if (!this.still(callId)) return stopAll(stream)
      const pc = this.connect(servers, stream)
      this.set({ local: stream })
      preferVp8(pc)
      await pc.setLocalDescription(await pc.createOffer())
      await gathered(pc, GATHER_MS)
      if (!this.still(callId)) return
      const sdp = pc.localDescription!.sdp
      this.described = true
      await this.core.callSignal(conversationId, { callId, kind: 'offer', sdp, video })
      this.later(RING_MS, () => void this.hangUp('No answer'))
    } catch (e) {
      if (this.still(callId)) this.finish(mediaError(e, video))
    }
  }

  /** Answers the ringing call; `video` false answers a video call with voice only. */
  async accept(video: boolean) {
    const offer = this.offer
    const state = this.state
    if (!offer || !state || state.phase !== 'incoming') return
    const { callId, conversationId } = state
    const sendVideo = state.video && video
    this.setupFrom = Date.now()
    this.set({ phase: 'connecting', cameraOff: !sendVideo })
    try {
      if (!canEncryptCalls()) throw new Error(NO_FRAME_ENCRYPTION)
      const servers = this.checkRelay(await this.core.iceServers())
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: sendVideo })
      if (!this.still(callId)) return stopAll(stream)
      const pc = this.connect(servers, stream)
      this.set({ local: stream })
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      await this.applyTheirCandidates()
      preferVp8(pc)
      await pc.setLocalDescription(await pc.createAnswer())
      await gathered(pc, GATHER_MS)
      if (!this.still(callId)) return
      this.peerDevice = offer.fromDevice
      const sdp = pc.localDescription!.sdp
      this.described = true
      await this.core.callSignal(conversationId, { callId, kind: 'answer', sdp, toDevice: offer.fromDevice })
      this.later(CONNECT_MS, () => void this.hangUp("Couldn't connect"))
    } catch (e) {
      if (!this.still(callId)) return
      await this.signal('hangup')
      this.finish(mediaError(e, sendVideo))
    }
  }

  async decline() {
    if (this.state?.phase !== 'incoming') return
    await this.signal('decline')
    this.finish('Declined')
  }

  /** Ends the call (or stops calling) for both sides. */
  async hangUp(reason = 'Call ended') {
    if (!this.busy) return
    if (this.state!.phase === 'incoming') return this.decline()
    await this.signal('hangup')
    this.finish(reason)
  }

  toggleMute() {
    if (!this.state || !this.stream) return
    const muted = !this.state.muted
    for (const t of this.stream.getAudioTracks()) t.enabled = !muted
    this.set({ muted })
  }

  toggleCamera() {
    if (!this.state || !this.stream) return
    const cameraOff = !this.state.cameraOff
    for (const t of this.stream.getVideoTracks()) t.enabled = !cameraOff
    this.set({ cameraOff })
  }

  /** Moves to the next camera (front/back on phones); the encrypted sender stays. */
  async switchCamera() {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'video')
    const current = sender?.track
    if (!sender || !current || !this.stream) return
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
    if (cameras.length < 2) return
    const at = cameras.findIndex((d) => d.deviceId === current.getSettings().deviceId)
    const next = cameras[(at + 1) % cameras.length]
    const media = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: next.deviceId } } })
    const track = media.getVideoTracks()[0]
    track.enabled = !this.state?.cameraOff
    await sender.replaceTrack(track)
    this.stream.removeTrack(current)
    current.stop()
    this.stream.addTrack(track)
    this.set({ local: new MediaStream(this.stream.getTracks()) })
  }

  /**
   * Shows the screen instead of the camera (video calls): the shared
   * screen goes out on the same sender, so it is SFrame-encrypted the same
   * way and needs no renegotiation. Stopping (here or in the browser's
   * own bar) brings the camera back.
   */
  async toggleScreenShare() {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'video')
    const camera = this.stream?.getVideoTracks()[0]
    if (!sender || !camera) return
    if (this.state?.sharing) {
      sender.track?.stop()
      await sender.replaceTrack(camera)
      this.set({ sharing: false, local: new MediaStream(this.stream!.getTracks()) })
      return
    }
    let screen: MediaStream
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    } catch {
      return // cancelled
    }
    const track = screen.getVideoTracks()[0]
    track.addEventListener('ended', () => this.state?.sharing && void this.toggleScreenShare())
    await sender.replaceTrack(track)
    this.set({ sharing: true, local: screen })
  }

  /** Plays the call on another audio output, where the browser allows it. */
  setSpeaker(deviceId: string) {
    this.set({ speaker: deviceId })
  }

  /** Dismisses the closing screen. */
  close() {
    if (this.state?.phase === 'ended') this.set(undefined)
  }

  private async onSignal(s: IncomingCallSignal) {
    const state = this.state
    if (s.kind === 'offer' && state && state.callId === s.callId && !state.outgoing && state.phase !== 'incoming') {
      // The caller restarted ICE (a new network): answer the new offer.
      if (!this.pc || !s.sdp || s.fromDevice !== this.peerDevice) return
      await this.pc.setRemoteDescription({ type: 'offer', sdp: s.sdp })
      await this.pc.setLocalDescription(await this.pc.createAnswer())
      await gathered(this.pc, GATHER_MS)
      const sdp = this.pc.localDescription!.sdp
      await this.core.callSignal(state.conversationId, { callId: s.callId, kind: 'answer', sdp, toDevice: s.fromDevice })
      return
    }
    if (s.kind === 'offer') {
      if (s.elsewhere || !s.sdp || s.group) return
      if (this.otherBusy()) {
        await this.core.callSignal(s.conversationId, { callId: s.callId, kind: 'busy', toDevice: s.fromDevice })
        return
      }
      if (this.busy && state!.callId !== s.callId) {
        // Both called each other at once: the lower call id goes ahead.
        const glare = state!.outgoing && state!.phase === 'calling' && state!.conversationId === s.conversationId
        if (!glare) {
          // Only the calling device hears it; the person's other devices may still answer.
          await this.core.callSignal(s.conversationId, { callId: s.callId, kind: 'busy', toDevice: s.fromDevice })
          return
        }
        if (s.callId > state!.callId) return
        await this.signal('hangup')
        this.reset()
        this.set(undefined)
      }
      if (this.busy) return
      this.reset()
      this.offer = s
      this.set({
        callId: s.callId,
        conversationId: s.conversationId,
        title: s.title,
        video: !!s.video,
        outgoing: false,
        phase: 'incoming',
        muted: false,
        cameraOff: false,
        cameras: 0,
      })
      // The caller gives up after RING_MS; this covers a lost hang-up.
      this.later(RING_MS + 15_000, () => this.finish('Missed call'))
      return
    }
    if (!state || state.callId !== s.callId || state.phase === 'ended') return
    if (s.elsewhere) {
      // Another of this user's devices answered or declined.
      if (state.phase === 'incoming' && s.kind === 'answer') this.finish('Answered on another device')
      else if (state.phase === 'incoming') this.finish('Declined on another device')
      return
    }
    switch (s.kind) {
      case 'answer':
        if (this.restarting && this.pc && s.sdp && s.fromDevice === this.peerDevice) {
          this.restarting = false
          await this.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp })
          return
        }
        if (!state.outgoing || this.peerDevice || !this.pc || !s.sdp) return
        this.peerDevice = s.fromDevice
        this.setupFrom = Date.now()
        await this.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp })
        await this.applyTheirCandidates()
        for (const candidate of this.ownCandidates.splice(0)) await this.sendCandidate(candidate)
        this.set({ phase: 'connecting' })
        this.later(CONNECT_MS, () => void this.hangUp("Couldn't connect"))
        return
      case 'candidate': {
        if (!s.candidate || (this.peerDevice ?? this.offer?.fromDevice) !== s.fromDevice) return
        let init: RTCIceCandidateInit
        try {
          init = JSON.parse(s.candidate) as RTCIceCandidateInit
        } catch {
          return
        }
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(init).catch(() => undefined)
        else this.theirCandidates.push(init)
        return
      }
      case 'hangup':
        if (this.peerDevice && s.fromDevice !== this.peerDevice) return
        this.finish(state.phase === 'incoming' ? 'Missed call' : 'Call ended')
        return
      case 'decline':
        if (state.outgoing) this.finish('Declined')
        return
      case 'busy':
        if (!state.outgoing || this.peerDevice) return
        // Stop the other person's other devices ringing too.
        await this.signal('hangup')
        this.finish('Line busy')
        return
    }
  }

  private connect(iceServers: RTCIceServer[], stream: MediaStream): RTCPeerConnection {
    const { conversationId, callId } = this.state!
    const config: RTCConfiguration & { encodedInsertableStreams?: boolean } = {
      iceServers,
      iceTransportPolicy: this.relayOnly ? 'relay' : 'all',
    }
    // Chromium without RTCRtpScriptTransform: encoded streams must be asked for up front.
    if (useEncodedStreams()) config.encodedInsertableStreams = true
    const pc = new RTCPeerConnection(config)
    this.pc = pc
    this.stream = stream
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream)
      this.core.protectMedia(sender, { conversationId, callId, direction: 'send', kind: track.kind as 'audio' | 'video' })
    }
    const remote = new MediaStream()
    pc.ontrack = (e) => {
      const kind = e.track.kind as 'audio' | 'video'
      this.core.protectMedia(e.receiver, { conversationId, callId, direction: 'receive', kind })
      remote.addTrack(e.track)
      this.set({ remote })
    }
    pc.onicecandidate = (e) => {
      if (!e.candidate || !this.described) return
      const json = JSON.stringify(e.candidate.toJSON())
      if (this.peerDevice) void this.sendCandidate(json)
      else this.ownCandidates.push(json)
    }
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      if (pc.connectionState === 'connected') {
        clearTimeout(this.timer)
        clearTimeout(this.dropTimer)
        clearTimeout(this.restartTimer)
        this.dropTimer = undefined
        this.restarting = false
        if (this.state?.phase !== 'active') {
          this.set({ phase: 'active', connectedAt: Date.now() })
          this.watchQuality(pc)
          void this.countCameras()
        }
      } else if (pc.connectionState === 'failed' && pc.remoteDescription) {
        // Firefox reports failure early when it has nothing to pair yet;
        // a failure with the other side's candidates gets an ICE restart,
        // and ends the call if that doesn't bring it back.
        this.dropTimer ??= setTimeout(() => void this.hangUp('Connection lost'), RECONNECT_MS)
        void this.restartIce()
      } else if (pc.connectionState === 'disconnected') {
        this.dropTimer ??= setTimeout(() => void this.hangUp('Connection lost'), RECONNECT_MS)
        clearTimeout(this.restartTimer)
        this.restartTimer = setTimeout(() => void this.restartIce(), RESTART_AFTER_MS)
      }
    }
    return pc
  }

  /** With "always relay" on, a call without a TURN server would leak nothing but also never connect. */
  private checkRelay(servers: IceServer[]): IceServer[] {
    if (this.relayOnly && !servers.some((s) => s.urls.some((u) => /^turns?:/.test(u))))
      throw new Error('This server has no call relay. Turn off "Always relay calls" in Settings to call.')
    return servers
  }

  /**
   * ICE restart (FR-CALL-8): the caller offers again with new ICE
   * credentials, through the same encrypted signalling; the callee answers.
   * Only the caller restarts, so the two never offer at once.
   */
  private async restartIce() {
    const state = this.state
    const pc = this.pc
    if (!state?.outgoing || !pc || !this.peerDevice || this.restarting || state.phase === 'ended') return
    this.restarting = true
    try {
      pc.restartIce()
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }))
      await gathered(pc, GATHER_MS)
      const sdp = pc.localDescription!.sdp
      await this.core.callSignal(state.conversationId, {
        callId: state.callId,
        kind: 'offer',
        sdp,
        video: state.video,
        toDevice: this.peerDevice,
      })
    } catch (e) {
      this.restarting = false
      console.warn('ICE restart failed', e)
    }
  }

  /** Rates the connection every few seconds and sends less video when it's poor. */
  private watchQuality(pc: RTCPeerConnection) {
    clearInterval(this.statsTimer)
    this.statsTimer = setInterval(async () => {
      if (this.pc !== pc) return clearInterval(this.statsTimer)
      const { loss, rttMs } = measure(await pc.getStats())
      const quality = rate(loss, rttMs)
      if (quality === this.state?.quality) return
      this.set({ quality })
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue
        const params = sender.getParameters()
        if (!params.encodings?.length) continue
        params.encodings[0].maxBitrate = VIDEO_BITRATE[quality]
        await sender.setParameters(params).catch(() => undefined)
      }
    }, STATS_EVERY_MS)
  }

  private async countCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    this.set({ cameras: devices.filter((d) => d.kind === 'videoinput').length })
  }

  private async sendCandidate(candidate: string) {
    const state = this.state
    if (!state || !this.peerDevice) return
    await this.core
      .callSignal(state.conversationId, { callId: state.callId, kind: 'candidate', candidate, toDevice: this.peerDevice })
      .catch((e) => console.warn('sending a candidate failed', e))
  }

  private async applyTheirCandidates() {
    for (const c of this.theirCandidates.splice(0)) await this.pc?.addIceCandidate(c).catch(() => undefined)
  }

  /** Sends a signal for the current call to everyone; failures are only logged. */
  private async signal(kind: 'hangup' | 'decline') {
    const state = this.state
    if (!state) return
    await this.core
      .callSignal(state.conversationId, { callId: state.callId, kind })
      .catch((e) => console.warn(`sending ${kind} failed`, e))
  }

  private still(callId: string): boolean {
    return this.state?.callId === callId && this.state.phase !== 'ended'
  }

  private later(ms: number, fn: () => void) {
    clearTimeout(this.timer)
    this.timer = setTimeout(fn, ms)
  }

  /** Releases the camera, microphone and connection. */
  private cleanUp() {
    for (const s of this.pc?.getSenders() ?? []) if (s.track && !this.stream?.getTracks().includes(s.track)) s.track.stop()
    clearTimeout(this.timer)
    clearTimeout(this.dropTimer)
    clearTimeout(this.restartTimer)
    clearInterval(this.statsTimer)
    this.restarting = false
    this.dropTimer = undefined
    if (this.stream) stopAll(this.stream)
    this.pc?.close()
    this.pc = undefined
    this.stream = undefined
  }

  private reset() {
    this.cleanUp()
    this.setupFrom = undefined
    this.peerDevice = undefined
    this.offer = undefined
    this.ownCandidates = []
    this.theirCandidates = []
    this.described = false
  }

  private finish(reason: string) {
    this.cleanUp()
    if (!this.state) return
    if (this.setupFrom !== undefined) {
      // Answered calls only: connected and not dropped, or failed (ADR-0032).
      const at = this.state.connectedAt
      const ok = at !== undefined && reason !== 'Connection lost'
      this.core.recordCall('direct', ok, at !== undefined ? at - this.setupFrom : undefined)
      this.setupFrom = undefined
    }
    const callId = this.state.callId
    this.set({ phase: 'ended', ended: reason, local: undefined, remote: undefined })
    setTimeout(() => this.state?.callId === callId && this.state.phase === 'ended' && this.set(undefined), ENDED_MS)
  }

  private set(patch: Partial<CallState> | CallState | undefined) {
    this.state = patch === undefined ? undefined : ({ ...this.state, ...patch } as CallState)
    for (const l of this.listeners) l()
  }
}

function stopAll(stream: MediaStream) {
  for (const t of stream.getTracks()) t.stop()
}

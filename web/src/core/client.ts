import { scriptUrl } from '../trusted-types'
import type {
  AppView,
  BenchResult,
  ChatMessage,
  CoreEvent,
  MemberInfo,
  CoreRequest,
  CoreResponseBody,
  CoreStatus,
  DeviceInfo,
  InviteOffer,
  LinkOffer,
  LocationInfo,
  MediaInfo,
  MediaSettings,
  ResponseEnvelope,
  SafetyNumber,
  BlockedContact,
  ReportReason,
  MediaEnvelope,
  CallSignal,
  GroupCallStatus,
  IceServer,
} from './protocol'
import type { MapInfo } from './maps'
import type { MediaTransformOptions } from './media'

/** Chromium's encoded insertable streams (before RTCRtpScriptTransform). */
type EncodedStreamsTarget = { createEncodedStreams(): { readable: ReadableStream; writable: WritableStream } }

/** Chromium's older API, used wherever it exists. */
export function useEncodedStreams(): boolean {
  return typeof RTCRtpSender !== 'undefined' && 'createEncodedStreams' in RTCRtpSender.prototype
}

/** Whether this browser can put call media through SFrame (ADR-0030). */
export function canEncryptCalls(): boolean {
  return (
    typeof RTCRtpScriptTransform !== 'undefined' ||
    (typeof RTCRtpSender !== 'undefined' && 'createEncodedStreams' in RTCRtpSender.prototype)
  )
}
import workerUrl from './worker.ts?worker&url'

/** The subset of `Worker` the client uses, so tests can substitute a fake. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<ResponseEnvelope>) => void): void
}

/** Promise-based access to the core worker, plus its pushed events. */
export class CoreClient {
  private nextId = 1
  private pending = new Map<number, (body: CoreResponseBody) => void>()
  private listeners = new Set<(event: CoreEvent) => void>()

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener('message', ({ data }) => {
      if ('event' in data) {
        for (const listener of this.listeners) listener(data.event)
        return
      }
      const resolve = this.pending.get(data.id)
      if (resolve) {
        this.pending.delete(data.id)
        resolve(data.body)
      }
    })
  }

  static start(): CoreClient {
    return new CoreClient(new Worker(scriptUrl(workerUrl), { type: 'module' }))
  }

  /** Subscribes to worker events; returns an unsubscribe function. */
  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async view(): Promise<AppView> {
    return expect(await this.call({ type: 'view' }), 'view').view
  }

  async signUp(username: string, displayName: string, invite?: string) {
    expect(await this.call({ type: 'signUp', username, displayName, invite }), 'ok')
  }

  async createInvite(): Promise<InviteOffer> {
    return expect(await this.call({ type: 'createInvite' }), 'invite').offer
  }

  async startChat(username: string): Promise<string> {
    return expect(await this.call({ type: 'startChat', username }), 'conversation').conversationId
  }

  async createGroup(name: string, usernames: string[]): Promise<string> {
    return expect(await this.call({ type: 'createGroup', name, usernames }), 'conversation').conversationId
  }

  async addMembers(conversationId: string, usernames: string[]) {
    expect(await this.call({ type: 'addMembers', conversationId, usernames }), 'ok')
  }

  async pushKey(): Promise<string> {
    return expect(await this.call({ type: 'pushKey' }), 'pushKey').key
  }

  async enablePush(subscription: PushSubscriptionJSON) {
    expect(await this.call({ type: 'enablePush', subscription }), 'ok')
  }

  async members(conversationId: string): Promise<MemberInfo[]> {
    return expect(await this.call({ type: 'members', conversationId }), 'members').members
  }

  async renameGroup(conversationId: string, name: string) {
    expect(await this.call({ type: 'renameGroup', conversationId, name }), 'ok')
  }

  async makeAdmin(conversationId: string, account: string) {
    expect(await this.call({ type: 'makeAdmin', conversationId, account }), 'ok')
  }

  async removeMember(conversationId: string, account: string) {
    expect(await this.call({ type: 'removeMember', conversationId, account }), 'ok')
  }

  async leaveGroup(conversationId: string) {
    expect(await this.call({ type: 'leaveGroup', conversationId }), 'ok')
  }

  async messages(conversationId: string): Promise<ChatMessage[]> {
    return expect(await this.call({ type: 'messages', conversationId }), 'messages').messages
  }

  async sendText(conversationId: string, text: string) {
    expect(await this.call({ type: 'sendText', conversationId, text }), 'ok')
  }

  /** New device: a code to show; the view turns 'ready' once approved. */
  async startLink(): Promise<LinkOffer> {
    return expect(await this.call({ type: 'startLink' }), 'link').offer
  }

  async cancelLink() {
    expect(await this.call({ type: 'cancelLink' }), 'ok')
  }

  /** Signed-in device: approves a scanned or typed code and adds the device. */
  async approveLink(text: string) {
    expect(await this.call({ type: 'approveLink', text }), 'ok')
  }

  async devices(): Promise<DeviceInfo[]> {
    return expect(await this.call({ type: 'devices' }), 'devices').devices
  }

  async removeDevice(id: string) {
    expect(await this.call({ type: 'removeDevice', id }), 'ok')
  }

  /** Reads a QR code from an RGBA camera frame, in the worker. */
  async decodeQr(rgba: Uint8Array, width: number, height: number): Promise<string | undefined> {
    return expect(await this.call({ type: 'decodeQr', rgba, width, height }), 'qr').text
  }

  async safetyNumber(conversationId: string, account: string): Promise<SafetyNumber> {
    return expect(await this.call({ type: 'safetyNumber', conversationId, account }), 'safety').safety
  }

  async markVerified(conversationId: string, account: string) {
    expect(await this.call({ type: 'markVerified', conversationId, account }), 'ok')
  }

  /** Throws if the scanned code doesn't match. */
  async verifyScanned(conversationId: string, account: string, text: string) {
    expect(await this.call({ type: 'verifyScanned', conversationId, account, text }), 'ok')
  }

  /** Re-sends a message that failed. */
  async sendLocation(conversationId: string, location: LocationInfo) {
    expect(await this.call({ type: 'sendLocation', conversationId, location }), 'ok')
  }

  /** Starts sharing a live location in one conversation (FR-LOC-2). */
  async startLive(conversationId: string, durationMs: number, location: LocationInfo) {
    expect(await this.call({ type: 'startLive', conversationId, durationMs, location }), 'ok')
  }

  /** A new position for every live session; the worker decides what to send. */
  async iceServers(): Promise<IceServer[]> {
    return expect(await this.call({ type: 'iceServers' }), 'iceServers').servers
  }

  async callSignal(conversationId: string, signal: CallSignal) {
    expect(await this.call({ type: 'callSignal', conversationId, signal }), 'ok')
  }

  async groupCallJoin(conversationId: string, callId: string): Promise<{ url: string; token: string }> {
    const { url, token } = expect(await this.call({ type: 'groupCallJoin', conversationId, callId }), 'groupCallJoin')
    return { url, token }
  }

  async groupCallStatus(conversationId: string): Promise<GroupCallStatus | undefined> {
    return expect(await this.call({ type: 'groupCallStatus', conversationId }), 'groupCallStatus').call
  }

  async deviceNames(conversationId: string): Promise<Record<string, string>> {
    return expect(await this.call({ type: 'deviceNames', conversationId }), 'deviceNames').names
  }

  async liveUpdate(location: LocationInfo) {
    expect(await this.call({ type: 'liveUpdate', location }), 'ok')
  }

  async stopLive(conversationId: string) {
    expect(await this.call({ type: 'stopLive', conversationId }), 'ok')
  }

  /** Whether the server has a basemap (ADR-0026). */
  async mapInfo(): Promise<MapInfo> {
    return expect(await this.call({ type: 'mapInfo' }), 'mapInfo').info
  }

  /** One basemap tile, fetched by the core worker. */
  async tile(z: number, x: number, y: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
    return expect(await this.call({ type: 'tile', z, x, y }), 'tile').data
  }

  /** Sends a photo or file; `caption` may be empty. */
  async sendFile(conversationId: string, file: File, caption: string, media?: MediaInfo) {
    expect(await this.call({ type: 'sendFile', conversationId, file, caption, media }), 'ok')
  }

  /** The decrypted file of a message. */
  async openAttachment(conversationId: string, messageId: string): Promise<Blob> {
    return expect(await this.call({ type: 'openAttachment', conversationId, messageId }), 'file').blob
  }

  async setMedia(media: MediaSettings) {
    expect(await this.call({ type: 'setMedia', media }), 'ok')
  }

  async retryMessage(conversationId: string, messageId: string) {
    expect(await this.call({ type: 'retryMessage', conversationId, messageId }), 'ok')
  }

  /** The user has seen this conversation's messages. */
  async markRead(conversationId: string) {
    expect(await this.call({ type: 'markRead', conversationId }), 'ok')
  }

  async setReadReceipts(on: boolean) {
    expect(await this.call({ type: 'setReadReceipts', on }), 'ok')
  }

  async setCallStats(on: boolean) {
    expect(await this.call({ type: 'setCallStats', on }), 'ok')
  }

  /** Counts a call for the opt-in statistics; never throws. */
  recordCall(kind: 'direct' | 'group', connected: boolean, setupMs?: number) {
    void this.call({ type: 'recordCall', kind, connected, setupMs })
  }

  async setRelayCalls(on: boolean) {
    expect(await this.call({ type: 'setRelayCalls', on }), 'ok')
  }

  /** Turns backups on; returns the recovery key to show once (ADR-0022). */
  async setupBackup(): Promise<string> {
    return expect(await this.call({ type: 'setupBackup' }), 'recoveryKey').key
  }

  async backupNow() {
    expect(await this.call({ type: 'backupNow' }), 'ok')
  }

  async turnOffBackup() {
    expect(await this.call({ type: 'turnOffBackup' }), 'ok')
  }

  /** New device: restores the account from its backup (ADR-0022). */
  async restore(username: string, recoveryKey: string) {
    expect(await this.call({ type: 'restore', username, recoveryKey }), 'ok')
  }

  /** Deletes the account and all its server data; `username` confirms it. */
  async deleteAccount(username: string) {
    expect(await this.call({ type: 'deleteAccount', username }), 'ok')
  }

  async acceptRequest(conversationId: string) {
    expect(await this.call({ type: 'acceptRequest', conversationId }), 'ok')
  }

  async block(account: string) {
    expect(await this.call({ type: 'block', account }), 'ok')
  }

  async unblock(account: string) {
    expect(await this.call({ type: 'unblock', account }), 'ok')
  }

  async blocked(): Promise<BlockedContact[]> {
    return expect(await this.call({ type: 'blocked' }), 'blocked').contacts
  }

  /** Reports `account`, optionally with their recent messages in this chat. */
  async report(conversationId: string, account: string, reason: ReportReason, includeMessages: boolean) {
    expect(await this.call({ type: 'report', conversationId, account, reason, includeMessages }), 'ok')
  }

  async dismissAlert(id: string) {
    expect(await this.call({ type: 'dismissAlert', id }), 'ok')
  }

  async status(): Promise<CoreStatus> {
    return expect(await this.call({ type: 'status' }), 'status').status
  }

  async bench(members: number): Promise<BenchResult> {
    return expect(await this.call({ type: 'bench', members }), 'bench').result
  }

  /**
   * Routes an RTP sender's or receiver's encoded frames through the core
   * worker, which SFrame-encrypts or decrypts them (ADR-0030).
   */
  protectMedia(target: RTCRtpSender | RTCRtpReceiver, options: MediaTransformOptions) {
    if (!useEncodedStreams()) {
      target.transform = new RTCRtpScriptTransform(this.worker as Worker, options)
      return
    }
    const streams = (target as unknown as EncodedStreamsTarget).createEncodedStreams()
    const message: MediaEnvelope = { media: options, readable: streams.readable, writable: streams.writable }
    this.worker.postMessage(message, [streams.readable, streams.writable] as unknown as Transferable[])
  }

  private call(request: CoreRequest): Promise<CoreResponseBody> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.worker.postMessage({ id, request })
    })
  }
}

function expect<T extends CoreResponseBody['type']>(
  body: CoreResponseBody,
  type: T,
): Extract<CoreResponseBody, { type: T }> {
  if (body.type === type) return body as Extract<CoreResponseBody, { type: T }>
  throw new Error(body.type === 'error' ? body.message : `unexpected response: ${body.type}`)
}

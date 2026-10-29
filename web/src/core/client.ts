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
  ResponseEnvelope,
  SafetyNumber,
  BlockedContact,
  ReportReason,
} from './protocol'
import workerUrl from './worker.ts?worker&url'

/** The subset of `Worker` the client uses, so tests can substitute a fake. */
export interface WorkerLike {
  postMessage(message: unknown): void
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

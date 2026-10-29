// The client engine. Runs in the core worker and owns the device keys,
// encrypted storage, REST calls and the WebSocket. The UI thread only
// receives `AppView` snapshots and message lists.

import init, {
  CoreClient,
  PendingClient,
  type ServerFrameView,
  decodeServerFrame,
  encodeAck,
  encodeAuthenticate,
  encodeSend,
} from './pkg/chat_core.js'
import { ApiError, api, fromBase64, toBase64 } from './api'
import { RecentIds, fromHex, makeIdentity, plain, randomId, splitIdentity, toHex } from './ids'
import type { AppView, ChatMessage, ConnectionState, CoreEvent } from './protocol'
import { SecureStore } from './storage'

const INITIAL_KEY_PACKAGES = 20
const MAX_RECONNECT_MS = 30_000

type Account = { phone: string; displayName: string; accountId: string; deviceId: string; token: string }

type Conversation = { id: string; peers: string[]; lastText?: string; lastAt: number }

/** An envelope waiting to be accepted by the server (FR-MSG-9). */
type Outgoing = { messageId: string; conversationId: string; envelope: string; recipients: string[] }

type State = {
  conversations: Record<string, Conversation>
  /** Account id (hex) → display name from their profile message. */
  names: Record<string, string>
  /** Account id (hex) → phone number, for contacts this user looked up. */
  phones: Record<string, string>
  outbox: Outgoing[]
  seen: string[]
}

const emptyState = (): State => ({ conversations: {}, names: {}, phones: {}, outbox: [], seen: [] })

export class Engine {
  private store!: SecureStore
  private account?: Account
  private core?: CoreClient
  private pending?: PendingClient
  private state: State = emptyState()
  private recent = new RecentIds()
  private ws?: WebSocket
  private connection: ConnectionState = 'offline'
  private nextRequestId = 1
  private waiters = new Map<number, (frame: ServerFrameView | undefined) => void>()
  private reconnectMs = 1000
  private flushing = false
  /** Serialises every mutation of core state and storage. */
  private lock: Promise<unknown> = Promise.resolve()

  constructor(private readonly emit: (event: CoreEvent) => void) {}

  async start() {
    await init()
    this.store = await SecureStore.open()
    this.account = await this.store.getJson<Account>('account')
    const snapshot = await this.store.getBytes('core')
    if (this.account && snapshot) {
      this.core = CoreClient.restore(snapshot)
      this.state = { ...emptyState(), ...(await this.store.getJson<State>('app')) }
      this.recent = new RecentIds(this.state.seen)
      this.connect()
    }
    this.emitView()
  }

  view(): AppView {
    if (!this.store) return { phase: 'loading' }
    if (!this.account) return { phase: 'signed-out' }
    const conversations = Object.values(this.state.conversations)
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((c) => ({ id: c.id, title: this.title(c), lastText: c.lastText, lastAt: c.lastAt }))
    return {
      phase: 'ready',
      me: { phone: this.account.phone, displayName: this.account.displayName },
      connection: this.connection,
      conversations,
    }
  }

  // ---- registration ------------------------------------------------------

  async requestCode(phone: string) {
    await api.requestCode(phone)
    this.pending = new PendingClient()
  }

  async verify(phone: string, code: string, displayName: string) {
    // A reload between the two steps loses the pending key; a new one is fine
    // because the public key is only sent now.
    this.pending ??= new PendingClient()
    const reg = await api.verify(phone, code, toBase64(this.pending.publicKey()))
    await this.exclusive(async () => {
      this.core = this.pending!.intoClient(makeIdentity(reg.account_id, reg.device_id))
      this.pending = undefined
      this.account = { phone, displayName, accountId: reg.account_id, deviceId: reg.device_id, token: reg.token }
      this.state = emptyState()
      const packages = this.core.keyPackages(INITIAL_KEY_PACKAGES) as Uint8Array[]
      await this.persist()
      await this.store.putJson('account', this.account)
      await api.uploadKeyPackages(reg.token, packages.map(toBase64))
    })
    this.connect()
    this.emitView()
  }

  // ---- conversations -------------------------------------------------------

  async startChat(phone: string): Promise<string> {
    const { account, core } = this.ready()
    if (phone === account.phone) throw new Error("You can't start a chat with yourself")
    const found = await api.lookup(account.token, phone)
    const peer = found.account_id.replaceAll('-', '')
    const existing = Object.values(this.state.conversations).find((c) => c.peers.length === 1 && c.peers[0] === peer)
    if (existing) return existing.id

    const claimed = await api.claim(account.token, found.device_ids)
    const devices = Object.keys(claimed.key_packages)
    if (devices.length === 0) throw new Error('This contact has no keys available right now; try again later')

    const id = await this.exclusive(async () => {
      const started = core.startConversation(devices.map((d) => fromBase64(claimed.key_packages[d])), randomId())
      const id = toHex(started.conversationId)
      this.state.phones[peer] = phone
      this.state.conversations[id] = { id, peers: [peer], lastAt: Date.now() }
      const welcomeId = randomId()
      this.state.outbox.push({
        messageId: toHex(welcomeId),
        conversationId: id,
        envelope: toBase64(started.welcome),
        recipients: devices.map((d) => d.replaceAll('-', '')),
      })
      this.queueProfile(id)
      await this.persist()
      return id
    })
    this.emitView()
    void this.flushOutbox()
    return id
  }

  async messages(conversationId: string): Promise<ChatMessage[]> {
    return (await this.store.getJson<ChatMessage[]>(`messages:${conversationId}`)) ?? []
  }

  async sendText(conversationId: string, text: string) {
    const { core } = this.ready()
    await this.exclusive(async () => {
      const messageId = randomId()
      const sentAt = Date.now()
      const envelope = core.sendText(fromHex(conversationId), text, sentAt, messageId)
      this.state.outbox.push({
        messageId: toHex(messageId),
        conversationId,
        envelope: toBase64(envelope),
        recipients: this.recipients(conversationId),
      })
      await this.appendMessage(conversationId, { id: toHex(messageId), from: 'me', text, sentAt, status: 'sending' })
      // The ratchet advanced: persist before anything leaves the device.
      await this.persist()
    })
    void this.flushOutbox()
  }

  // ---- WebSocket -------------------------------------------------------------

  private connect() {
    if (!this.account || this.ws) return
    const url = new URL('/v1/ws', self.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.setConnection('connecting')

    ws.onopen = () => ws.send(plain(encodeAuthenticate(this.requestId(), this.account!.token)))
    ws.onmessage = (event) => this.onFrame(decodeServerFrame(new Uint8Array(event.data as ArrayBuffer)))
    ws.onclose = () => {
      this.ws = undefined
      for (const resolve of this.waiters.values()) resolve(undefined)
      this.waiters.clear()
      this.setConnection('offline')
      setTimeout(() => this.connect(), this.reconnectMs)
      this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS)
    }
  }

  private onFrame(frame: ServerFrameView) {
    switch (frame.kind) {
      case 'auth':
        this.reconnectMs = 1000
        this.setConnection('online')
        void this.flushOutbox()
        return
      case 'deliver':
        void this.onDeliver(frame.envelope, frame.messageId)
        return
      default: {
        const waiter = this.waiters.get(frame.requestId)
        if (waiter) {
          this.waiters.delete(frame.requestId)
          waiter(frame)
        } else if (frame.kind === 'error') {
          console.warn(`server error ${frame.errorCode}: ${frame.errorMessage}`)
        }
      }
    }
  }

  private async onDeliver(envelope: Uint8Array, messageId: Uint8Array) {
    await this.exclusive(async () => {
      const id = toHex(messageId)
      if (!this.recent.has(id)) {
        try {
          await this.apply(this.core!.receive(envelope), id)
        } catch (e) {
          // Undecryptable input must not block the queue forever.
          console.warn('dropping envelope that could not be processed', e)
        }
        this.recent.add(id)
        await this.persist()
      }
    })
    // Ack only after the result is stored (docs/11-api.md).
    this.ws?.send(plain(encodeAck(0, messageId)))
    void this.flushOutbox()
  }

  private async apply(event: ReturnType<CoreClient['receive']>, messageId: string) {
    const conversationId = toHex(event.conversationId)
    if (event.kind === 'joined') {
      const me = toHex(this.core!.identity())
      const peers = (this.core!.members(event.conversationId) as Uint8Array[])
        .filter((m) => toHex(m) !== me)
        .map((m) => splitIdentity(m).account)
      this.state.conversations[conversationId] = { id: conversationId, peers, lastAt: Date.now() }
      this.queueProfile(conversationId)
      // Joining consumed one of our key packages; publish a replacement.
      const [replacement] = this.core!.keyPackages(1) as Uint8Array[]
      api.uploadKeyPackages(this.account!.token, [toBase64(replacement)]).catch((e) => console.warn(e))
      this.emitView()
    } else if (event.kind === 'message') {
      const from = splitIdentity(event.sender).account
      if (event.displayName !== undefined) {
        this.state.names[from] = event.displayName.slice(0, 64)
        this.emitView()
      }
      if (event.text !== undefined) {
        await this.appendMessage(conversationId, {
          id: messageId,
          from,
          text: event.text,
          sentAt: event.sentAtMs,
          status: 'received',
        })
      }
    }
  }

  /** Sends queued envelopes in order, one at a time. */
  private async flushOutbox() {
    if (this.flushing || this.connection !== 'online') return
    this.flushing = true
    try {
      while (this.state.outbox.length > 0 && this.connection === 'online') {
        const item = this.state.outbox[0]
        const result = await this.request((id) =>
          encodeSend(id, fromBase64(item.envelope), item.recipients.map(fromHex)),
        )
        if (!result) return // disconnected: retry after reconnecting
        const ok = result.kind === 'send_result' && result.accepted
        if (!ok) console.warn('send rejected', result.errorCode, result.errorMessage)
        await this.exclusive(async () => {
          this.state.outbox.shift()
          await this.setStatus(item.conversationId, item.messageId, ok ? 'sent' : 'failed')
          await this.persist()
        })
      }
    } finally {
      this.flushing = false
    }
  }

  private request(encode: (requestId: number) => Uint8Array): Promise<ServerFrameView | undefined> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(undefined)
    const id = this.requestId()
    return new Promise((resolve) => {
      this.waiters.set(id, resolve)
      ws.send(plain(encode(id)))
    })
  }

  // ---- helpers ---------------------------------------------------------------

  private queueProfile(conversationId: string) {
    const messageId = randomId()
    const envelope = this.core!.sendProfile(fromHex(conversationId), this.account!.displayName, Date.now(), messageId)
    this.state.outbox.push({
      messageId: toHex(messageId),
      conversationId,
      envelope: toBase64(envelope),
      recipients: this.recipients(conversationId),
    })
  }

  /** Device ids (hex) of every member except this device. */
  private recipients(conversationId: string): string[] {
    const me = toHex(this.core!.identity())
    return (this.core!.members(fromHex(conversationId)) as Uint8Array[])
      .filter((m) => toHex(m) !== me)
      .map((m) => toHex(splitIdentity(m).device))
  }

  private title(c: Conversation): string {
    const names = c.peers.map((p) => this.state.names[p] ?? this.state.phones[p] ?? 'New contact')
    return names.join(', ') || 'Just you'
  }

  private async appendMessage(conversationId: string, message: ChatMessage) {
    const list = await this.messages(conversationId)
    list.push(message)
    await this.store.putJson(`messages:${conversationId}`, list)
    const conv = this.state.conversations[conversationId]
    if (conv) {
      conv.lastText = message.text
      conv.lastAt = Math.max(conv.lastAt, message.sentAt)
    }
    this.emit({ type: 'messages', conversationId })
    this.emitView()
  }

  private async setStatus(conversationId: string, messageId: string, status: ChatMessage['status']) {
    const list = await this.messages(conversationId)
    const message = list.find((m) => m.id === messageId)
    if (!message) return
    message.status = status
    await this.store.putJson(`messages:${conversationId}`, list)
    this.emit({ type: 'messages', conversationId })
  }

  private async persist() {
    this.state.seen = this.recent.toJSON()
    await this.store.putBytes('core', this.core!.snapshot())
    await this.store.putJson('app', this.state)
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => undefined)
    return run
  }

  private ready(): { account: Account; core: CoreClient } {
    if (!this.account || !this.core) throw new Error('not signed in')
    return { account: this.account, core: this.core }
  }

  private requestId(): number {
    this.nextRequestId = (this.nextRequestId % 0x7fff_ffff) + 1
    return this.nextRequestId
  }

  private setConnection(state: ConnectionState) {
    this.connection = state
    this.emitView()
  }

  private emitView() {
    this.emit({ type: 'view', view: this.view() })
  }
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : String(e)
}

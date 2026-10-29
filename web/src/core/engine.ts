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
  encodeSendWithWelcome,
  encodeQr,
} from './pkg/chat_core.js'
import { ApiError, type Registered, api, fromBase64, toBase64 } from './api'
import { type CommitOutcome, RATE_LIMITED, commitWasAccepted, retryDelay, throwUnlessAccepted } from './commits'
import { RecentIds, fromHex, makeIdentity, plain, randomId, splitIdentity, toHex } from './ids'
import { type DeviceSync, deviceHex, linkText, ownDevicePlan, parseDeviceSync, parseLinkCode } from './devices'
import type { AppView, ChatMessage, ConnectionState, CoreEvent, DeviceInfo, LinkOffer, MemberInfo } from './protocol'
import { acceptsGroupInfo, designatedCommitter, parseAdmins } from './roles'
import { SecureStore } from './storage'

const INITIAL_KEY_PACKAGES = 20
const MAX_RECONNECT_MS = 30_000
const MAX_GROUP_MEMBERS = 50
/** Envelopes held for conversations not yet joined (see `onDeliver`). */
const MAX_EARLY = 200
/** Link codes live 10 minutes on the server (ADR-0019). */
const LINK_POLL_MS = 2_000
const LINK_TTL_MS = 10 * 60_000
/** How long the approving device waits for the new one to register. */
const LINK_APPROVAL_WAIT_MS = 2 * 60_000

type Account = { phone: string; displayName: string; accountId: string; deviceId: string; token: string }

type Conversation = {
  id: string
  peers: string[]
  name?: string
  /** Admin account ids in priority order (groups only, ADR-0016). */
  admins?: string[]
  /** 'left' or 'removed': history stays readable, sending is disabled. */
  status?: 'left' | 'removed'
  /** The account's private conversation of its own devices (ADR-0019); hidden. */
  self?: boolean
  lastText?: string
  lastAt: number
}

/** A contact resolved through the key directory, with one key package per device. */
type Invitee = { phone: string; account: string; devices: string[]; keyPackages: Uint8Array[] }

/** An envelope waiting to be accepted by the server (FR-MSG-9). */
type Outgoing = { messageId: string; conversationId: string; envelope: string; recipients: string[] }

/**
 * A commit sent to the server whose answer was lost (the connection
 * dropped). It stays pending in the core until the server says which commit
 * it accepted for that epoch (docs/03 §5.3).
 */
type PendingCommit = {
  conversationId: string
  /** Base64 SHA-256 of the commit ciphertext. */
  commitHash: string
  /**
   * For commits that add people. Their welcome travels with the commit (the
   * server accepts both together, ADR-0017); this records who was invited.
   */
  invitees?: { account: string; phone: string; devices: string[] }[]
}

/** An envelope that arrived before the welcome to its conversation. */
type Early = { conversationId: string; messageId: string; envelope: string }

type State = {
  conversations: Record<string, Conversation>
  /** Account id (hex) → display name from their profile message. */
  names: Record<string, string>
  /** Account id (hex) → phone number, for contacts this user looked up. */
  phones: Record<string, string>
  outbox: Outgoing[]
  early: Early[]
  /** Conversation id → accounts that proposed leaving, awaiting a commit. */
  leaving: Record<string, string[]>
  pendingCommit?: PendingCommit
  seen: string[]
  /** This account's devices (hex), from the server (ADR-0019). */
  myDevices: string[]
  /** Group metadata from another own device, for conversations not joined yet. */
  syncedMeta: DeviceSync['conversations']
}

const emptyState = (): State => ({
  conversations: {},
  names: {},
  phones: {},
  outbox: [],
  early: [],
  leaving: {},
  seen: [],
  myDevices: [],
  syncedMeta: {},
})

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
  /** Consecutive rate-limited sends, and the timer for the next attempt. */
  private limitedSends = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  /** Pending own-device reconciliation (see `syncOwnDevices`). */
  private syncTimer?: ReturnType<typeof setTimeout>
  /** Sync runs, one after another (a caller may need the next one to finish). */
  private syncChain: Promise<void> = Promise.resolve()
  /** The link code this (signed-out) device is waiting on. */
  private linkCode?: string
  private notice?: string

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
    if (!this.account) return { phase: 'signed-out', notice: this.notice }
    const conversations = Object.values(this.state.conversations)
      .filter((c) => !c.self)
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((c) => ({
        id: c.id,
        title: this.title(c),
        isGroup: c.name !== undefined || c.peers.length > 1,
        amAdmin: (c.admins ?? []).includes(this.myAccount()),
        status: c.status ?? ('active' as const),
        memberCount: c.peers.length + 1,
        lastText: c.lastText,
        lastAt: c.lastAt,
      }))
    return {
      phase: 'ready',
      me: { phone: this.account.phone, displayName: this.account.displayName || this.account.phone },
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
    await this.register(reg, displayName)
  }

  private async register(reg: Registered, displayName: string) {
    await this.exclusive(async () => {
      this.core = this.pending!.intoClient(makeIdentity(reg.account_id, reg.device_id))
      this.pending = undefined
      this.notice = undefined
      this.account = {
        phone: reg.phone,
        displayName,
        accountId: reg.account_id,
        deviceId: reg.device_id,
        token: reg.token,
      }
      this.state = emptyState()
      const packages = this.core.keyPackages(INITIAL_KEY_PACKAGES) as Uint8Array[]
      await this.persist()
      await this.store.putJson('account', this.account)
      await api.uploadKeyPackages(reg.token, packages.map(toBase64))
    })
    this.connect()
    this.emitView()
  }

  // ---- linked devices (ADR-0019) ---------------------------------------------

  /**
   * On a new device: gets a link code to show, then waits in the background
   * until a signed-in device approves it and registers this device.
   */
  async startLink(): Promise<LinkOffer> {
    if (this.account) throw new Error('Already signed in')
    const { code } = await api.linkStart()
    this.pending ??= new PendingClient()
    this.linkCode = code
    void this.awaitLink(code, Date.now() + LINK_TTL_MS)
    const qr = encodeQr(linkText(code))
    const offer = { code, qrSize: qr.size, qrModules: Array.from(qr.modules) }
    qr.free()
    return offer
  }

  cancelLink() {
    this.linkCode = undefined
  }

  private async awaitLink(code: string, until: number) {
    while (this.linkCode === code && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, LINK_POLL_MS))
      if (this.linkCode !== code || !this.pending) return
      try {
        const reg = await api.linkComplete(code, toBase64(this.pending.publicKey()))
        this.linkCode = undefined
        // No name until the first DeviceSync from another device brings it;
        // until then this device introduces itself to no one.
        await this.register(reg, '')
        return
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) continue // not approved yet
        if (e instanceof ApiError && e.status === 404) return // expired
        console.warn('link polling failed', e)
      }
    }
  }

  /**
   * On a signed-in device: approves a scanned or typed link code, waits for
   * the new device to register, then adds it to every conversation.
   */
  async approveLink(text: string) {
    const { account } = this.ready()
    const code = parseLinkCode(text)
    if (!code) throw new Error("That isn't a link code from this app")
    if (this.connection !== 'online') throw new Error('You need to be online to link a device')
    await api.linkApprove(account.token, code)
    const until = Date.now() + LINK_APPROVAL_WAIT_MS
    while (Date.now() < until) {
      const { device_id } = await api.linkStatus(account.token, code)
      if (device_id) {
        await this.syncOwnDevices()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, LINK_POLL_MS))
    }
    throw new Error('The new device did not finish linking; try again')
  }

  async devices(): Promise<DeviceInfo[]> {
    const { devices } = await api.devices(this.ready().account.token)
    return devices.map((d) => ({
      id: d.device_id,
      addedOn: d.added_on,
      lastSeenOn: d.last_seen_on ?? undefined,
      current: d.current,
    }))
  }

  /** Removes another of this account's devices, then from every group. */
  async removeDevice(id: string) {
    await api.removeDevice(this.ready().account.token, id)
    await this.syncOwnDevices()
  }

  /** Called when the server no longer knows this device (it was removed). */
  private async signOut(notice: string) {
    this.account = undefined
    this.core = undefined
    this.state = emptyState()
    this.notice = notice
    const ws = this.ws
    this.ws = undefined
    ws?.close()
    await this.store.clear()
    this.setConnection('offline')
  }

  /** Runs `syncOwnDevices` soon, coalescing bursts (e.g. many joins). */
  private scheduleSync() {
    clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => void this.syncOwnDevices(), 500)
  }

  /**
   * Keeps this account's devices in each of its groups (ADR-0019): adds
   * missing ones, removes deleted ones, and creates the self conversation.
   */
  private syncOwnDevices(): Promise<void> {
    const run = this.syncChain.then(() => this.runSync())
    this.syncChain = run.catch(() => undefined)
    return run
  }

  private async runSync() {
    if (!this.account || this.connection !== 'online') return
    try {
      const { devices } = await api.devices(this.account.token)
      const mine = devices.map((d) => deviceHex(d.device_id))
      this.state.myDevices = mine
      const thisDevice = deviceHex(this.account.deviceId)
      const hasSelf = Object.values(this.state.conversations).some((c) => c.self && !c.status)
      // The oldest device creates it; duplicates from races are tolerated.
      if (!hasSelf && mine.length > 1 && mine[0] === thisDevice) await this.createSelfConversation(mine)
      for (const id of Object.keys(this.state.conversations)) {
        try {
          await this.reconcileDevices(id, mine)
        } catch (e) {
          console.warn('updating devices in a conversation failed', e)
        }
      }
    } catch (e) {
      console.warn('device sync failed', e)
    }
    this.emitView()
  }

  private async reconcileDevices(conversationId: string, mine: string[]) {
    const { account, core } = this.ready()
    const conv = this.state.conversations[conversationId]
    if (!conv || conv.status || this.state.pendingCommit) return
    const me = this.myAccount()
    const members = (core.members(fromHex(conversationId)) as Uint8Array[]).map((m) => {
      const { account, device } = splitIdentity(m)
      return { account, device: toHex(device) }
    })
    const plan = ownDevicePlan(members, me, deviceHex(account.deviceId), mine)
    if (!plan) return
    if (plan.stale.length > 0) {
      await this.exclusive(async () => {
        if (this.state.pendingCommit || this.connection !== 'online') return
        await this.flushOutbox(true)
        const everyone = this.recipients(conversationId)
        const staged = core.removeMembers(
          fromHex(conversationId),
          plan.stale.map((d) => fromHex(me + d)),
          randomId(),
        )
        const pending: PendingCommit = { conversationId, commitHash: toBase64(staged.commitHash) }
        await this.sendCommit(pending, staged.commit, everyone)
      })
      return // anything missing is added on the next pass
    }
    if (plan.missing.length === 0) return
    const invitee = await this.ownInvitee(plan.missing)
    if (!invitee) return
    await this.exclusive(async () => {
      if (this.state.pendingCommit || this.connection !== 'online') return
      await this.flushOutbox(true)
      const existing = this.recipients(conversationId)
      const added = core.addMembers(fromHex(conversationId), invitee.keyPackages, randomId(), randomId())
      const pending: PendingCommit = {
        conversationId,
        commitHash: toBase64(added.commitHash),
        invitees: [{ account: me, phone: account.phone, devices: invitee.devices }],
      }
      const welcome = { envelope: added.welcome, recipients: invitee.devices }
      await this.sendCommit(pending, added.commit, existing, welcome)
    })
  }

  /** Claims key packages for some of this account's devices (hex ids). */
  private async ownInvitee(devices: string[]): Promise<Invitee | undefined> {
    const { account } = this.ready()
    if (devices.length === 0) return undefined
    const claimed = await api.claim(account.token, devices)
    const packages = new Map(Object.entries(claimed.key_packages).map(([id, kp]) => [deviceHex(id), kp]))
    const found = devices.filter((d) => packages.has(d))
    if (found.length === 0) return undefined
    return {
      phone: account.phone,
      account: this.myAccount(),
      devices: found,
      keyPackages: found.map((d) => fromBase64(packages.get(d)!)),
    }
  }

  /** This account's other devices, for new conversations. */
  private async otherOwnDevices(): Promise<Invitee | undefined> {
    const thisDevice = deviceHex(this.ready().account.deviceId)
    return this.ownInvitee(this.state.myDevices.filter((d) => d !== thisDevice))
  }

  private async createSelfConversation(mine: string[]) {
    const thisDevice = deviceHex(this.ready().account.deviceId)
    const invitee = await this.ownInvitee(mine.filter((d) => d !== thisDevice))
    if (!invitee) return
    await this.exclusive(async () => {
      const started = this.core!.startConversation(invitee.keyPackages, randomId())
      const id = toHex(started.conversationId)
      this.state.conversations[id] = { id, peers: [], self: true, lastAt: Date.now() }
      this.state.outbox.push({
        messageId: toHex(randomId()),
        conversationId: id,
        envelope: toBase64(started.welcome),
        recipients: invitee.devices,
      })
      this.queueDeviceSync(id)
      await this.persist()
    })
    void this.flushOutbox()
  }

  /** Shares names and group metadata with this account's other devices. */
  private queueDeviceSync(selfId: string) {
    const sync: DeviceSync = {
      displayName: this.account!.displayName,
      names: this.state.names,
      phones: this.state.phones,
      conversations: Object.fromEntries(
        Object.values(this.state.conversations)
          .filter((c) => !c.self && !c.status)
          .map((c) => [c.id, { name: c.name, admins: c.admins }]),
      ),
    }
    const messageId = randomId()
    const envelope = this.core!.sendDeviceSync(
      fromHex(selfId),
      new TextEncoder().encode(JSON.stringify(sync)),
      Date.now(),
      messageId,
    )
    this.state.outbox.push({
      messageId: toHex(messageId),
      conversationId: selfId,
      envelope: toBase64(envelope),
      recipients: this.recipients(selfId),
    })
  }

  /** Applies a `DeviceSync` from another of this account's devices. */
  private async applyDeviceSync(conversationId: string, bytes: Uint8Array) {
    const sync = parseDeviceSync(bytes)
    const conv = this.state.conversations[conversationId]
    if (!sync || !conv) return
    conv.self = true
    conv.peers = []
    if (sync.displayName && this.account) {
      this.account.displayName = sync.displayName
      await this.store.putJson('account', this.account)
    }
    this.state.names = { ...sync.names, ...this.state.names }
    this.state.phones = { ...sync.phones, ...this.state.phones }
    for (const [id, meta] of Object.entries(sync.conversations)) {
      const target = this.state.conversations[id]
      if (target) this.applyMeta(target, meta)
      else this.state.syncedMeta[id] = meta
    }
    for (const c of Object.values(this.state.conversations)) this.emit({ type: 'messages', conversationId: c.id })
    this.emitView()
  }

  private applyMeta(conv: Conversation, meta: { name?: string; admins?: string[] }) {
    if (conv.name === undefined && meta.name) conv.name = meta.name
    if ((conv.admins ?? []).length === 0 && meta.admins?.length) conv.admins = meta.admins
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
    const own = await this.otherOwnDevices()

    const id = await this.exclusive(async () => {
      const started = core.startConversation(
        [...devices.map((d) => fromBase64(claimed.key_packages[d])), ...(own?.keyPackages ?? [])],
        randomId(),
      )
      const id = toHex(started.conversationId)
      this.state.phones[peer] = phone
      this.state.conversations[id] = { id, peers: [peer], lastAt: Date.now() }
      const welcomeId = randomId()
      this.state.outbox.push({
        messageId: toHex(welcomeId),
        conversationId: id,
        envelope: toBase64(started.welcome),
        recipients: [...devices.map(deviceHex), ...(own?.devices ?? [])],
      })
      this.queueProfile(id)
      await this.persist()
      return id
    })
    this.emitView()
    void this.flushOutbox()
    return id
  }

  /** Creates a group with everyone at once (no other member can race us). */
  async createGroup(name: string, phones: string[]): Promise<string> {
    const { core } = this.ready()
    const groupName = name.trim().slice(0, 64)
    if (!groupName) throw new Error('Give the group a name')
    const invitees = await this.resolve(phones)
    if (invitees.length === 0) throw new Error('Add at least one other person')
    if (invitees.length + 1 > MAX_GROUP_MEMBERS) throw new Error(`Groups are limited to ${MAX_GROUP_MEMBERS} people`)
    const own = await this.otherOwnDevices()
    const everyone = own ? [...invitees, own] : invitees

    const id = await this.exclusive(async () => {
      const started = core.startConversation(everyone.flatMap((i) => i.keyPackages), randomId())
      const id = toHex(started.conversationId)
      for (const i of invitees) this.state.phones[i.account] = i.phone
      const admins = [this.myAccount()]
      this.state.conversations[id] = {
        id,
        peers: invitees.map((i) => i.account),
        name: groupName,
        admins,
        lastAt: Date.now(),
      }
      this.state.outbox.push({
        messageId: toHex(randomId()),
        conversationId: id,
        envelope: toBase64(started.welcome),
        recipients: everyone.flatMap((i) => i.devices),
      })
      this.queueGroupInfo(id, groupName, admins)
      this.queueProfile(id)
      await this.persist()
      return id
    })
    this.emitView()
    void this.flushOutbox()
    return id
  }

  /**
   * Adds people to an existing conversation. The commit must be accepted by
   * the server before it is applied locally, so this needs a connection.
   */
  async addMembers(conversationId: string, phones: string[]) {
    const { core } = this.ready()
    const conv = this.state.conversations[conversationId]
    if (!conv) throw new Error('Unknown conversation')
    if (this.connection !== 'online') throw new Error('You need to be online to add people')
    if (this.state.pendingCommit) throw new Error('Still finishing an earlier group change; try again shortly')
    const invitees = (await this.resolve(phones)).filter((i) => !conv.peers.includes(i.account))
    if (invitees.length === 0) throw new Error('Everyone listed is already in this conversation')
    if (conv.peers.length + invitees.length + 1 > MAX_GROUP_MEMBERS) {
      throw new Error(`Groups are limited to ${MAX_GROUP_MEMBERS} people`)
    }

    await this.exclusive(async () => {
      // Queued messages were encrypted for the current epoch: send them first.
      await this.flushOutbox(true)
      const existing = this.recipients(conversationId)
      const added = core.addMembers(
        fromHex(conversationId),
        invitees.flatMap((i) => i.keyPackages),
        randomId(),
        randomId(),
      )
      const pending: PendingCommit = {
        conversationId,
        commitHash: toBase64(added.commitHash),
        invitees: invitees.map(({ account, phone, devices }) => ({ account, phone, devices })),
      }
      const welcome = { envelope: added.welcome, recipients: invitees.flatMap((i) => i.devices) }
      throwUnlessAccepted(await this.sendCommit(pending, added.commit, existing, welcome), 'adding people')
    })
    this.emitView()
    void this.flushOutbox()
  }

  /** Members of a conversation, including this user. */
  members(conversationId: string): MemberInfo[] {
    const conv = this.group(conversationId)
    const me = this.myAccount()
    return [me, ...conv.peers].map((account) => ({
      account,
      name: account === me ? this.account!.displayName || this.account!.phone : this.nameOf(account),
      isAdmin: (conv.admins ?? []).includes(account),
      isMe: account === me,
    }))
  }

  async renameGroup(conversationId: string, name: string) {
    const conv = this.requireAdmin(conversationId)
    const groupName = name.trim().slice(0, 64)
    if (!groupName) throw new Error('Give the group a name')
    await this.exclusive(async () => {
      conv.name = groupName
      this.queueGroupInfo(conversationId, groupName, conv.admins ?? [])
      await this.persist()
    })
    this.emitView()
    void this.flushOutbox()
  }

  async makeAdmin(conversationId: string, account: string) {
    const conv = this.requireAdmin(conversationId)
    if (!conv.peers.includes(account)) throw new Error('Not a member of this group')
    await this.exclusive(async () => {
      conv.admins = [...new Set([...(conv.admins ?? []), account])]
      this.queueGroupInfo(conversationId, conv.name ?? '', conv.admins)
      await this.persist()
    })
    this.emitView()
    void this.flushOutbox()
  }

  /** Removes all of an account's devices (admins only). Needs a connection. */
  async removeMember(conversationId: string, account: string) {
    const { core } = this.ready()
    const conv = this.requireAdmin(conversationId)
    if (!conv.peers.includes(account)) throw new Error('Not a member of this group')
    this.requireCommitPossible()
    await this.exclusive(async () => {
      await this.flushOutbox(true)
      // The removed member gets the commit too, so they learn they're out.
      const everyone = this.recipients(conversationId)
      const staged = core.removeMembers(fromHex(conversationId), [fromHex(account)], randomId())
      const pending: PendingCommit = { conversationId, commitHash: toBase64(staged.commitHash) }
      throwUnlessAccepted(await this.sendCommit(pending, staged.commit, everyone), 'removing them')
    })
    this.emitView()
    void this.flushOutbox()
  }

  /** Proposes our own removal; another member commits it (ADR-0016). */
  async leaveGroup(conversationId: string) {
    const { core } = this.ready()
    const conv = this.group(conversationId)
    if (conv.status) return
    await this.exclusive(async () => {
      const messageId = randomId()
      const proposal = core.leave(fromHex(conversationId), messageId)
      this.state.outbox.push({
        messageId: toHex(messageId),
        conversationId,
        envelope: toBase64(proposal),
        recipients: this.recipients(conversationId),
      })
      conv.status = 'left'
      await this.persist()
    })
    this.emitView()
    void this.flushOutbox()
  }

  /** The server's VAPID public key (base64url) for `pushManager.subscribe`. */
  async pushKey(): Promise<string> {
    return (await api.pushKey()).public_key
  }

  /** Registers this device's push subscription with the server. */
  async enablePush(subscription: PushSubscriptionJSON) {
    await api.subscribePush(this.ready().account.token, subscription)
  }

  async messages(conversationId: string): Promise<ChatMessage[]> {
    const list = (await this.store.getJson<ChatMessage[]>(`messages:${conversationId}`)) ?? []
    return list.map((m) => (m.from === 'me' ? m : { ...m, fromName: this.nameOf(m.from) }))
  }

  async sendText(conversationId: string, text: string) {
    const { core } = this.ready()
    if (this.state.pendingCommit?.conversationId === conversationId) {
      throw new Error('Finishing a group change; try again when you are back online')
    }
    if (this.state.conversations[conversationId]?.status) throw new Error("You're no longer in this group")
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
      if (this.ws !== ws) return // replaced or signed out
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
        // Queued before any delivery handler, so it settles first.
        void this.exclusive(() => this.resolvePendingCommit()).then(() => {
          this.commitDepartures()
          this.scheduleSync()
          return this.flushOutbox()
        })
        return
      case 'deliver':
        void this.onDeliver(frame)
        return
      default: {
        const waiter = this.waiters.get(frame.requestId)
        if (waiter) {
          this.waiters.delete(frame.requestId)
          waiter(frame)
        } else if (frame.kind === 'error' && frame.errorCode === 401 && this.connection !== 'online') {
          // Our token was refused: another device removed this one.
          void this.signOut('This device was removed from your account.')
        } else if (frame.kind === 'error') {
          console.warn(`server error ${frame.errorCode}: ${frame.errorMessage}`)
        }
      }
    }
  }

  private async onDeliver(frame: ServerFrameView) {
    const { envelope, messageId } = frame
    await this.exclusive(async () => {
      const id = toHex(messageId)
      if (!this.recent.has(id)) {
        const conversationId = toHex(frame.conversationId)
        if (!frame.welcome && !this.state.conversations[conversationId]) {
          // When someone adds us, other members can react to the commit
          // (e.g. send their profile) before the adder's welcome reaches the
          // server. Hold such envelopes until we join.
          this.state.early.push({ conversationId, messageId: id, envelope: toBase64(envelope) })
          if (this.state.early.length > MAX_EARLY) this.state.early.shift()
        } else {
          await this.process(envelope, id)
        }
        this.recent.add(id)
        await this.persist()
      }
    })
    // Ack only after the result is stored (docs/11-api.md).
    this.ws?.send(plain(encodeAck(0, messageId)))
    this.commitDepartures()
    void this.flushOutbox()
  }

  private commitDepartures() {
    for (const conversationId of Object.keys(this.state.leaving)) void this.commitProposalsIfDue(conversationId)
  }

  /** Commits members' departures if this user is the designated committer. */
  private async commitProposalsIfDue(conversationId: string) {
    await this.exclusive(async () => {
      const core = this.core!
      const conv = this.state.conversations[conversationId]
      const leavers = this.state.leaving[conversationId] ?? []
      if (!conv || conv.status || this.state.pendingCommit || this.connection !== 'online') return
      if (!core.hasPendingProposals(fromHex(conversationId))) {
        delete this.state.leaving[conversationId]
        return
      }
      const members = [
        ...new Set((core.members(fromHex(conversationId)) as Uint8Array[]).map((m) => splitIdentity(m).account)),
      ]
      if (designatedCommitter(conv.admins, members, leavers) !== this.myAccount()) return
      await this.flushOutbox(true)
      const everyone = this.recipients(conversationId)
      const staged = core.commitProposals(fromHex(conversationId), randomId())
      const pending: PendingCommit = { conversationId, commitHash: toBase64(staged.commitHash) }
      // A conflict means another member committed first; nothing to do.
      await this.sendCommit(pending, staged.commit, everyone)
    })
    this.emitView()
  }

  private async process(envelope: Uint8Array, messageId: string) {
    try {
      await this.apply(this.core!.receive(envelope), messageId)
    } catch (e) {
      // Undecryptable input must not block the queue forever.
      console.warn('dropping envelope that could not be processed', e)
    }
  }

  private async apply(event: ReturnType<CoreClient['receive']>, messageId: string) {
    const conversationId = toHex(event.conversationId)
    if (event.kind === 'joined') {
      const conv: Conversation = { id: conversationId, peers: this.peersOf(conversationId), lastAt: Date.now() }
      const meta = this.state.syncedMeta[conversationId]
      if (meta) {
        this.applyMeta(conv, meta)
        delete this.state.syncedMeta[conversationId]
      }
      this.state.conversations[conversationId] = conv
      this.scheduleSync()
      this.queueProfile(conversationId)
      // Joining consumed one of our key packages; publish a replacement.
      const [replacement] = this.core!.keyPackages(1) as Uint8Array[]
      api.uploadKeyPackages(this.account!.token, [toBase64(replacement)]).catch((e) => console.warn(e))
      this.emitView()
      const early = this.state.early.filter((e) => e.conversationId === conversationId)
      this.state.early = this.state.early.filter((e) => e.conversationId !== conversationId)
      for (const e of early) await this.process(fromBase64(e.envelope), e.messageId)
    } else if (event.kind === 'epoch') {
      const conv = this.state.conversations[conversationId]
      if (!conv) return
      const peers = this.peersOf(conversationId)
      if (!this.core!.isActive(event.conversationId)) {
        // A commit removed us (or committed our own departure).
        conv.status ??= 'removed'
        this.emitView()
        return
      }
      if (conv.self) return
      // Introduce ourselves to anyone new.
      if (peers.some((p) => !conv.peers.includes(p))) this.queueProfile(conversationId)
      conv.peers = peers
      this.emitView()
    } else if (event.kind === 'proposal') {
      // A member asked to leave; the designated member commits it once this
      // envelope is stored (see `commitProposalsIfDue`).
      const leaver = splitIdentity(event.sender).account
      this.state.leaving[conversationId] = [...new Set([...(this.state.leaving[conversationId] ?? []), leaver])]
      const conv = this.state.conversations[conversationId]
      if (leaver === this.myAccount() && conv && !conv.status) {
        // Left from another of our devices: follow (ADR-0019).
        const messageId = randomId()
        const proposal = this.core!.leave(event.conversationId, messageId)
        this.state.outbox.push({
          messageId: toHex(messageId),
          conversationId,
          envelope: toBase64(proposal),
          recipients: this.recipients(conversationId),
        })
        conv.status = 'left'
        this.emitView()
      }
    } else if (event.kind === 'message') {
      const from = splitIdentity(event.sender).account
      const conv = this.state.conversations[conversationId]
      const mine = from === this.myAccount()
      if (event.deviceSync !== undefined) {
        if (mine) await this.applyDeviceSync(conversationId, event.deviceSync)
        return
      }
      if (event.groupName !== undefined && conv && acceptsGroupInfo(conv.admins, from)) {
        if (event.groupName) conv.name = event.groupName.slice(0, 64)
        const admins = parseAdmins(event.groupAdmins)
        if (admins.length > 0) conv.admins = admins
        this.emitView()
      }
      if (conv?.status && event.text !== undefined) return // no longer in the group
      if (event.displayName !== undefined && !mine) {
        this.state.names[from] = event.displayName.slice(0, 64)
        this.emitView()
        // Sender names are resolved when messages are read: refresh lists.
        for (const c of Object.values(this.state.conversations)) {
          if (c.peers.includes(from)) this.emit({ type: 'messages', conversationId: c.id })
        }
      }
      if (event.text !== undefined) {
        // Sent from another of our devices: show it as ours.
        await this.appendMessage(conversationId, {
          id: messageId,
          from: mine ? 'me' : from,
          text: event.text,
          sentAt: event.sentAtMs,
          status: mine ? 'sent' : 'received',
        })
      }
    }
  }

  /**
   * Sends queued envelopes in order, one at a time. `locked` is set when the
   * caller already holds the exclusive lock.
   */
  private async flushOutbox(locked = false) {
    if (this.flushing || this.connection !== 'online') return
    this.flushing = true
    try {
      while (this.state.outbox.length > 0 && this.connection === 'online') {
        const item = this.state.outbox[0]
        const result = await this.request((id) =>
          encodeSend(id, fromBase64(item.envelope), item.recipients.map(fromHex)),
        )
        if (!result) return // disconnected: retry after reconnecting
        if (result.kind === 'error' && result.errorCode === RATE_LIMITED) {
          // Keep the message queued and try again later, in order.
          clearTimeout(this.retryTimer)
          this.retryTimer = setTimeout(() => void this.flushOutbox(), retryDelay(this.limitedSends++))
          return
        }
        this.limitedSends = 0
        const ok = result.kind === 'send_result' && result.accepted
        if (!ok) console.warn('send rejected', result.errorCode, result.errorMessage)
        const settle = async () => {
          this.state.outbox.shift()
          await this.setStatus(item.conversationId, item.messageId, ok ? 'sent' : 'failed')
          await this.persist()
        }
        await (locked ? settle() : this.exclusive(settle))
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

  /**
   * Sends a staged commit and waits for the server. Accepted: applied.
   * Conflict: discarded. No answer: kept pending until reconnect.
   */
  private async sendCommit(
    pending: PendingCommit,
    commit: Uint8Array,
    recipients: string[],
    welcome?: { envelope: Uint8Array; recipients: string[] },
  ): Promise<CommitOutcome> {
    const id = fromHex(pending.conversationId)
    if (recipients.length === 0 && !welcome) {
      // Nobody else to tell (e.g. the last other member left).
      await this.finishCommit(pending)
      return 'accepted'
    }
    const result = await this.request((requestId) =>
      welcome
        ? encodeSendWithWelcome(
            requestId,
            commit,
            recipients.map(fromHex),
            welcome.envelope,
            welcome.recipients.map(fromHex),
          )
        : encodeSend(requestId, commit, recipients.map(fromHex)),
    )
    if (!result) {
      // The server may or may not have accepted it; ask once reconnected.
      this.state.pendingCommit = pending
      await this.persist()
      return 'lost'
    }
    if (result.kind === 'send_result' && result.accepted) {
      await this.finishCommit(pending)
      return 'accepted'
    }
    this.core!.discardCommit(id)
    if (result.kind === 'error' && result.errorCode === RATE_LIMITED) return 'limited'
    return result.epochConflict ? 'conflict' : 'rejected'
  }

  /** Applies an accepted commit; for additions, introduces us to newcomers. */
  private async finishCommit(p: PendingCommit) {
    const conv = this.state.conversations[p.conversationId]
    this.core!.confirmCommit(fromHex(p.conversationId))
    if (conv) conv.peers = this.peersOf(p.conversationId)
    if (!this.core!.hasPendingProposals(fromHex(p.conversationId))) delete this.state.leaving[p.conversationId]
    if (p.invitees && conv?.self) {
      this.queueDeviceSync(p.conversationId)
    } else if (p.invitees) {
      for (const i of p.invitees) if (i.account !== this.myAccount()) this.state.phones[i.account] = i.phone
      if (conv?.name) this.queueGroupInfo(p.conversationId, conv.name, conv.admins ?? [])
      this.queueProfile(p.conversationId)
    }
    this.state.pendingCommit = undefined
    await this.persist()
    this.emitView()
  }

  /** Settles a commit whose server answer was lost (see `PendingCommit`). */
  private async resolvePendingCommit() {
    const p = this.state.pendingCommit
    if (!p) return
    let serverHash: string | undefined
    try {
      serverHash = (await api.groupEpoch(this.account!.token, toBase64(fromHex(p.conversationId)))).last_commit_hash
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) return // try again on the next reconnect
    }
    if (commitWasAccepted(p.commitHash, serverHash)) {
      await this.finishCommit(p)
    } else {
      this.core!.discardCommit(fromHex(p.conversationId))
      this.state.pendingCommit = undefined
      await this.persist()
    }
  }

  /** Resolves phone numbers to accounts and claims a key package per device. */
  private async resolve(phones: string[]): Promise<Invitee[]> {
    const { account } = this.ready()
    const unique = [...new Set(phones.map((p) => p.trim()).filter(Boolean))].filter((p) => p !== account.phone)
    const found = await Promise.all(
      unique.map(async (phone) => {
        try {
          return { phone, ...(await api.lookup(account.token, phone)) }
        } catch (e) {
          throw new Error(`${phone}: ${describeError(e)}`)
        }
      }),
    )
    const claimed = await api.claim(account.token, found.flatMap((f) => f.device_ids))
    return found.map((f) => {
      const devices = f.device_ids.filter((d) => claimed.key_packages[d])
      if (devices.length === 0) throw new Error(`${f.phone} has no keys available right now; try again later`)
      return {
        phone: f.phone,
        account: f.account_id.replaceAll('-', ''),
        devices: devices.map((d) => d.replaceAll('-', '')),
        keyPackages: devices.map((d) => fromBase64(claimed.key_packages[d])),
      }
    })
  }

  private queueGroupInfo(conversationId: string, name: string, admins: string[]) {
    const messageId = randomId()
    const envelope = this.core!.sendGroupInfo(
      fromHex(conversationId),
      name,
      admins.map(fromHex),
      Date.now(),
      messageId,
    )
    this.state.outbox.push({
      messageId: toHex(messageId),
      conversationId,
      envelope: toBase64(envelope),
      recipients: this.recipients(conversationId),
    })
  }

  private queueProfile(conversationId: string) {
    if (!this.account!.displayName) return // linked device still waiting for its name
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

  private myAccount(): string {
    return this.account ? this.account.accountId.replaceAll('-', '') : ''
  }

  /** Other members' account ids, from the core's current group state. */
  private peersOf(conversationId: string): string[] {
    const me = this.myAccount()
    const accounts = (this.core!.members(fromHex(conversationId)) as Uint8Array[]).map((m) => splitIdentity(m).account)
    return [...new Set(accounts.filter((a) => a !== me))]
  }

  private group(conversationId: string): Conversation {
    const conv = this.state.conversations[conversationId]
    if (!conv) throw new Error('Unknown conversation')
    return conv
  }

  private requireAdmin(conversationId: string): Conversation {
    const conv = this.group(conversationId)
    if (conv.status) throw new Error("You're no longer in this group")
    if (!(conv.admins ?? []).includes(this.myAccount())) throw new Error('Only group admins can do that')
    return conv
  }

  private requireCommitPossible() {
    if (this.connection !== 'online') throw new Error('You need to be online to change the group')
    if (this.state.pendingCommit) throw new Error('Still finishing an earlier group change; try again shortly')
  }

  private nameOf(account: string): string {
    return this.state.names[account] ?? this.state.phones[account] ?? 'New contact'
  }

  private title(c: Conversation): string {
    return c.name ?? (c.peers.map((p) => this.nameOf(p)).join(', ') || 'Just you')
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

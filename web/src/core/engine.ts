// The client engine. Runs in the core worker and owns the device keys,
// encrypted storage, REST calls and the WebSocket. The UI thread only
// receives `AppView` snapshots and message lists.

import init, {
  AttachmentView,
  type CallView,
  CoreClient,
  type LiveLocationView,
  PendingClient,
  type ServerFrameView,
  decodeServerFrame,
  encodeAck,
  encodeAuthenticate,
  encodeSend,
  encodeSendWithWelcome,
  encodeQr,
  safetyNumber,
  sealedLength,
} from './pkg/chat_core.js'
import { ApiError, type Registered, api, fromBase64, toBase64 } from './api'
import {
  type CommitOutcome,
  MAX_SEND_RETRIES,
  RATE_LIMITED,
  commitWasAccepted,
  retryDelay,
  sendOutcome,
  throwUnlessAccepted,
} from './commits'
import { RecentIds, fromHex, makeIdentity, plain, randomId, splitIdentity, toHex } from './ids'
import { type DeviceSync, deviceHex, linkText, memberDevicePlan, parseDeviceSync, parseLinkCode } from './devices'
import { applyReceipt, splitIds } from './receipts'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_RECEIVED_THUMB_BYTES,
  MAX_THUMB_BYTES,
  attachmentLabel,
  hexToUuid,
  openFile,
  prepareImage,
  renamed,
  safeDuration,
  safeMime,
  safeName,
  safeSize,
  sealFile,
  uuidToHex,
} from './attachments'
import {
  deriveBackupKeys,
  formatRecoveryKey,
  newRecoveryKey,
  openBackup,
  parseRecoveryKey,
  sealBackup,
  sha256,
} from './backup'
import {
  KEY_PACKAGE_TARGET,
  type KeyBook,
  keyPackagesToUpload,
  observeKeys,
  scannedMatches,
  verification,
  verifyText,
} from './keys'
import type {
  AppView,
  CallSignal,
  ChatMessage,
  IceServer,
  ConnectionState,
  CoreEvent,
  FileInfo,
  DeviceInfo,
  InviteOffer,
  LinkOffer,
  LocationInfo,
  MediaSettings,
  MemberInfo,
  SafetyNumber,
} from './protocol'
import { type MediaInfo, isPhoto, isPlayable } from './protocol'
import { isMp4, scrubMp4 } from './mp4'
import { DEFAULT_MEDIA, autoDownloads, onMobileData } from './policy'
import * as transfers from './transfers'
import { safeLocation } from './maps'
import { LIVE_DURATIONS_MS, plausibleExpiry, updateDue } from './live'
import { CALL_KINDS, type CallEnd, type CallRecord, GIVE_UP_MS, STALE_OFFER_MS, callNotice, safeSignalText } from './calls'
import { acceptsGroupInfo, designatedCommitter, parseAdmins } from './roles'
import { SecureStore } from './storage'

/** How long the server may take to answer a request before we reconnect. */
const REQUEST_TIMEOUT_MS = 20_000
/** Upload a backup at most this often, when something changed (ADR-0022). */
const BACKUP_INTERVAL_MS = 10 * 60_000
/** Check members' device lists this often while connected (ADR-0022). */
const MEMBER_CHECK_MS = 10 * 60_000
/** Check the server's key-package count this often while connected. */
const KEY_PACKAGE_CHECK_MS = 6 * 60 * 60_000
const MAX_RECONNECT_MS = 30_000
const MAX_GROUP_MEMBERS = 50
/** Envelopes held for conversations not yet joined (see `onDeliver`). */
const MAX_EARLY = 200
/** Link codes live 10 minutes on the server (ADR-0019). */
const LINK_POLL_MS = 2_000
const LINK_TTL_MS = 10 * 60_000
/** How long the approving device waits for the new one to register. */
const LINK_APPROVAL_WAIT_MS = 2 * 60_000

/** An attachment as stored: what the UI sees, plus how to fetch and open it (ADR-0024). */
type StoredFile = Omit<FileInfo, 'thumbnail'> & {
  /** Hex blob id, once uploaded. */
  blobId?: string
  /** Base64 key and ciphertext SHA-256. */
  key: string
  digest: string
  /** Base64 JPEG. */
  thumbnail?: string
  /** A resumable upload in progress (ADR-0025). */
  uploadId?: string
}

/** A message as stored; `messages()` hands the UI a `ChatMessage` without keys. */
type StoredMessage = Omit<ChatMessage, 'file'> & { file?: StoredFile }

type Account = { username: string; displayName: string; accountId: string; deviceId: string; token: string }

type Conversation = {
  id: string
  peers: string[]
  name?: string
  /** Admin account ids in priority order (groups only, ADR-0016). */
  admins?: string[]
  /** 'left' or 'removed': history stays readable, sending is disabled. */
  status?: 'left' | 'removed' | 'restoring'
  /** The account's private conversation of its own devices (ADR-0019); hidden. */
  self?: boolean
  /** Started by someone this user has no connection to, until accepted (FR-SAF-3). */
  request?: boolean
  /** Received messages not yet seen. */
  unread?: number
  lastText?: string
  lastAt: number
}

/** A contact resolved through the key directory, with one key package per device. */
type Invitee = { username: string; account: string; devices: string[]; keyPackages: Uint8Array[] }

/** A live-location session this device sends. */
type LiveSession = {
  sessionId: string
  conversationId: string
  /** The message that started it, which shows the session. */
  messageId: string
  expiresAt: number
  lastSentAt: number
  last?: LocationInfo
}

/** An envelope waiting to be accepted by the server (FR-MSG-9). */
type Outgoing = {
  messageId: string
  conversationId: string
  envelope: string
  recipients: string[]
  /** No Web Push for offline recipients (receipts). */
  silent?: boolean
  /** Transient failures so far (rate limits, server trouble). */
  attempts?: number
}

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
  invitees?: { account: string; username: string; devices: string[] }[]
}

/** An envelope that arrived before the welcome to its conversation. */
type Early = { conversationId: string; messageId: string; envelope: string }

type State = {
  conversations: Record<string, Conversation>
  /** Account id (hex) → display name from their profile message. */
  names: Record<string, string>
  /** Account id (hex) → username number, for contacts this user looked up. */
  usernames: Record<string, string>
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
  /** Every device signature key seen per account (ADR-0020). */
  keys: KeyBook
  /** Account → their keys when this user verified the safety number. */
  verified: Record<string, string[]>
  /** Own devices this device approved, so their arrival raises no alert. */
  expectedOwn: string[]
  /** New devices on this account that nobody here approved. */
  alerts: { id: string; text: string }[]
  /** Blocked account ids (FR-ID-8); their messages are dropped. */
  blocked: string[]
  /** Whether to send read receipts (FR-MSG-5); delivery receipts always go. */
  readReceipts: boolean
  /** Encrypted backups (ADR-0022): on, and when the last one was uploaded. */
  backup?: { lastAt?: number }
  /** Auto-download and photo quality (ADR-0025). */
  media: MediaSettings
  /** Live-location sessions this device is sending (FR-LOC-2). */
  live: LiveSession[]
  /** Others' sessions shown here, to forget their points when they end. */
  liveSeen: { conversationId: string; messageId: string; expiresAt: number }[]
  /** Attachment uploads and downloads to resume after a reload or reconnect. */
  transfers: { conversationId: string; messageId: string; kind: 'upload' | 'download' }[]
}

/** What a backup holds (ADR-0022): no MLS state, keys or tokens. */
type BackupPayload = {
  version: 1
  createdAt: number
  displayName: string
  state: Pick<State, 'conversations' | 'names' | 'usernames' | 'blocked' | 'verified' | 'keys' | 'readReceipts'>
  messages: Record<string, StoredMessage[]>
}

const emptyState = (): State => ({
  conversations: {},
  names: {},
  usernames: {},
  outbox: [],
  early: [],
  leaving: {},
  seen: [],
  myDevices: [],
  syncedMeta: {},
  keys: {},
  verified: {},
  expectedOwn: [],
  alerts: [],
  blocked: [],
  readReceipts: true,
  media: DEFAULT_MEDIA,
  live: [],
  liveSeen: [],
  transfers: [],
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
  /** A link code this device is approving (ADR-0019), until the new device is known. */
  private approving?: string
  /** Uploads under way, by message id. */
  private inflight = new Set<string>()
  private liveTimer?: ReturnType<typeof setInterval>
  /** The page's latest position while this device shares. */
  private liveFix?: LocationInfo
  /** Calls ringing or running, by call id (ADR-0028); not kept across restarts. */
  private calls = new Map<string, CallRecord>()
  private callTimer?: ReturnType<typeof setInterval>
  /** Downloads under way, by message id. */
  private downloads = new Map<string, Promise<Blob>>()
  private nextRequestId = 1
  private waiters = new Map<number, (frame: ServerFrameView | undefined) => void>()
  private reconnectMs = 1000
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private flushing = false
  /** Timer for re-sending after a transient failure. */
  private retryTimer?: ReturnType<typeof setTimeout>
  private replenishing = false
  /** Something changed since the last backup upload. */
  private backupDirty = false
  private backupTimer?: ReturnType<typeof setInterval>
  private keyCheckTimer?: ReturnType<typeof setInterval>
  private memberCheckTimer?: ReturnType<typeof setInterval>
  /** Pending own-device reconciliation (see `syncOwnDevices`). */
  private syncTimer?: ReturnType<typeof setTimeout>
  /** Sync runs, one after another (a caller may need the next one to finish). */
  private syncChain: Promise<void> = Promise.resolve()
  /** The link code this (signed-out) device is waiting on. */
  private linkCode?: string
  private notice?: string
  /** Receipts to send, per conversation, batched (see `queueReceipt`). */
  private receipts = new Map<string, { delivered: string[]; read: string[] }>()
  private receiptTimer?: ReturnType<typeof setTimeout>

  /** Serialises every mutation of core state and storage. */
  private lock: Promise<unknown> = Promise.resolve()

  constructor(private readonly emit: (event: CoreEvent) => void) {}

  async start() {
    // Back on the network: reconnect now rather than after the back-off.
    self.addEventListener('online', () => {
      if (this.ws || !this.account) return
      clearTimeout(this.reconnectTimer)
      this.reconnectMs = 1000
      this.connect()
    })
    await init()
    this.store = await SecureStore.open()
    this.account = await this.store.getJson<Account>('account')
    const snapshot = await this.store.getBytes('core')
    if (this.account && snapshot) {
      this.core = CoreClient.restore(snapshot)
      this.state = { ...emptyState(), ...(await this.store.getJson<State>('app')) }
      this.recent = new RecentIds(this.state.seen)
      if (this.state.live.length > 0 || this.state.liveSeen.length > 0) this.scheduleLiveSweep()
      this.connect()
    }
    this.emitView()
  }

  view(): AppView {
    if (!this.store) return { phase: 'loading' }
    if (!this.account) return { phase: 'signed-out', notice: this.notice }
    const conversations = Object.values(this.state.conversations)
      .filter((c) => !c.self && !this.isBlockedChat(c))
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((c) => ({
        id: c.id,
        title: this.title(c),
        isGroup: c.name !== undefined || c.peers.length > 1,
        amAdmin: (c.admins ?? []).includes(this.myAccount()),
        status: c.status ?? ('active' as const),
        memberCount: c.peers.length + 1,
        peer: c.name === undefined && c.peers.length === 1 ? c.peers[0] : undefined,
        blocked: c.name === undefined && c.peers.length === 1 && this.state.blocked.includes(c.peers[0]),
        request: c.request ?? false,
        unread: c.unread ?? 0,
        verification: c.name === undefined && c.peers.length === 1 ? this.verificationOf(c.peers[0]) : undefined,
        lastText: c.lastText,
        lastAt: c.lastAt,
      }))
    return {
      phase: 'ready',
      me: { username: this.account.username, displayName: this.account.displayName || this.account.username },
      connection: this.connection,
      conversations,
      alerts: this.state.alerts,
      readReceipts: this.state.readReceipts,
      backup: this.state.backup ? { lastAt: this.state.backup.lastAt } : undefined,
      media: this.state.media,
      liveSharing: this.state.live
        .filter((l) => l.expiresAt > Date.now())
        .map((l) => ({
          conversationId: l.conversationId,
          title: this.state.conversations[l.conversationId] ? this.title(this.state.conversations[l.conversationId]) : '',
          expiresAt: l.expiresAt,
        })),
    }
  }

  // ---- registration ------------------------------------------------------

  /** Creates the account with this device as its first (ADR-0021). */
  async signUp(username: string, displayName: string, invite?: string) {
    this.pending ??= new PendingClient()
    const reg = await api.register(username.trim(), invite?.trim() || undefined, toBase64(this.pending.publicKey()))
    await this.register(reg, displayName)
  }

  /** An invite link for someone to sign up with (ADR-0021). */
  async createInvite(): Promise<InviteOffer> {
    const { code, expires_in_days } = await api.createInvite(this.ready().account.token)
    const link = `${self.location.origin}/#invite=${code}`
    const qr = encodeQr(link)
    const offer = { link, expiresInDays: expires_in_days, qrSize: qr.size, qrModules: Array.from(qr.modules) }
    qr.free()
    return offer
  }

  /** `prepare` runs after the new identity exists and before connecting. */
  private async register(reg: Registered, displayName: string, prepare?: () => Promise<void>) {
    await this.exclusive(async () => {
      this.core = this.pending!.intoClient(makeIdentity(reg.account_id, reg.device_id))
      this.pending = undefined
      this.notice = undefined
      this.account = {
        username: reg.username,
        displayName,
        accountId: reg.account_id,
        deviceId: reg.device_id,
        token: reg.token,
      }
      this.state = emptyState()
      const packages = this.core.keyPackages(KEY_PACKAGE_TARGET) as Uint8Array[]
      await this.persist()
      await this.store.putJson('account', this.account)
      await api.uploadKeyPackages(reg.token, packages.map(toBase64))
      await prepare?.()
    })
    this.connect()
    this.emitView()
  }

  // ---- backup and restore (ADR-0022) -----------------------------------------

  /** Turns backups on with a new recovery key; returns it, to show once. */
  async setupBackup(): Promise<string> {
    const { account } = this.ready()
    const recovery = newRecoveryKey()
    const keys = await deriveBackupKeys(recovery)
    await api.setBackupKey(account.token, toBase64(await sha256(keys.auth)))
    await this.store.putKey('backup', keys.encryption)
    await this.exclusive(async () => {
      this.state.backup = {}
      await this.persist()
    })
    await this.backupNow()
    return formatRecoveryKey(recovery)
  }

  async turnOffBackup() {
    await api.deleteBackup(this.ready().account.token)
    await this.store.putKey('backup', undefined)
    await this.exclusive(async () => {
      this.state.backup = undefined
      await this.persist()
    })
    this.emitView()
  }

  /** Encrypts this device's history and uploads it. */
  async backupNow() {
    const { account } = this.ready()
    const key = await this.store.getKey('backup')
    if (!key || !this.state.backup) return
    const payload = await this.exclusive(async () => {
      const messages: Record<string, StoredMessage[]> = {}
      const conversations: State['conversations'] = {}
      for (const c of Object.values(this.state.conversations)) {
        if (c.self) continue
        conversations[c.id] = c
        messages[c.id] = await this.stored(c.id)
      }
      const { names, usernames, blocked, verified, keys, readReceipts } = this.state
      return {
        version: 1,
        createdAt: Date.now(),
        displayName: account.displayName,
        state: { conversations, names, usernames, blocked, verified, keys, readReceipts },
        messages,
      } satisfies BackupPayload
    })
    await api.uploadBackup(account.token, await sealBackup(key, payload))
    await this.exclusive(async () => {
      if (this.state.backup) this.state.backup.lastAt = payload.createdAt
      await this.persist()
    })
    this.backupDirty = false
    this.emitView()
  }

  /**
   * On a new device: proves the recovery key, becomes the account's only
   * device and restores the history. Conversations wait until members add
   * this device back (ADR-0022).
   */
  async restore(username: string, recoveryText: string) {
    if (this.account) throw new Error('Already signed in')
    const recovery = parseRecoveryKey(recoveryText)
    if (!recovery) throw new Error('A recovery key is 26 letters and digits, like ABCD-EFGH-…')
    const keys = await deriveBackupKeys(recovery)
    this.pending ??= new PendingClient()
    const reg = await api.restore(username.trim(), toBase64(keys.auth), toBase64(this.pending.publicKey()))
    await this.register(reg, '', async () => {
      const backup = await openBackup<BackupPayload>(keys.encryption, await api.downloadBackup(reg.token))
      this.account!.displayName = backup.displayName
      await this.store.putJson('account', this.account)
      const restored = backup.state
      for (const c of Object.values(restored.conversations)) {
        c.status = c.status ?? 'restoring'
        c.request = undefined
        await this.store.putJson(`messages:${c.id}`, backup.messages[c.id] ?? [])
      }
      // This device is the account's own: its key must not raise an alert.
      Object.assign(this.state, restored, {
        backup: { lastAt: backup.createdAt },
        expectedOwn: [deviceHex(reg.device_id)],
      })
      await this.store.putKey('backup', keys.encryption)
      await this.persist()
    })
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
    this.approving = code
    try {
      const until = Date.now() + LINK_APPROVAL_WAIT_MS
      while (Date.now() < until) {
        if (await this.expectLinkedDevice(code)) {
          await this.syncOwnDevices()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, LINK_POLL_MS))
      }
      throw new Error('The new device did not finish linking; try again')
    } finally {
      this.approving = undefined
    }
  }

  /** Records the device a link code registered, once it has; true if it has. */
  private async expectLinkedDevice(code: string): Promise<boolean> {
    const { device_id } = await api.linkStatus(this.ready().account.token, code)
    if (!device_id) return false
    const device = deviceHex(device_id)
    if (!this.state.expectedOwn.includes(device)) this.state.expectedOwn = [...this.state.expectedOwn, device]
    return true
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

  /**
   * Deletes the account and everything the server holds for it (FR-ID-9),
   * after leaving every group so other members' groups don't keep it.
   */
  async deleteAccount(username: string) {
    const { account, core } = this.ready()
    if (username.trim().toLowerCase() !== account.username) throw new Error("That isn't this account's username")
    if (this.connection !== 'online') throw new Error('You need to be online to delete your account')
    await this.exclusive(async () => {
      for (const conv of Object.values(this.state.conversations)) {
        const recipients = conv.status ? [] : this.recipients(conv.id)
        if (conv.self || recipients.length === 0) continue
        const messageId = randomId()
        const proposal = core.leave(fromHex(conv.id), messageId)
        this.state.outbox.push({
          messageId: toHex(messageId),
          conversationId: conv.id,
          envelope: toBase64(proposal),
          recipients,
        })
        conv.status = 'left'
      }
      await this.persist()
      await this.flushOutbox(true)
    })
    await api.deleteAccount(account.token, account.username)
    await this.signOut('Your account was deleted.')
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
   * Keeps every member's devices in each group (ADR-0019, ADR-0022): adds
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
      const live = await this.liveDevices(mine)
      for (const id of Object.keys(this.state.conversations)) {
        try {
          await this.reconcileDevices(id, live)
        } catch (e) {
          console.warn('updating devices in a conversation failed', e)
        }
      }
    } catch (e) {
      console.warn('device sync failed', e)
    }
    this.emitView()
  }

  /**
   * Every member account's current devices (hex), from the server; accounts
   * it doesn't return no longer exist (ADR-0022).
   */
  private async liveDevices(mine: string[]): Promise<Record<string, string[]>> {
    const me = this.myAccount()
    const others = new Set<string>()
    for (const c of Object.values(this.state.conversations)) {
      if (c.status) continue
      for (const m of this.core!.members(fromHex(c.id)) as Uint8Array[]) {
        const { account } = splitIdentity(m)
        if (account !== me) others.add(account)
      }
    }
    const live: Record<string, string[]> = { [me]: mine }
    const accounts = [...others]
    for (let i = 0; i < accounts.length; i += 200) {
      const chunk = accounts.slice(i, i + 200)
      const { devices } = await api.devicesOf(this.account!.token, chunk)
      for (const [account, ids] of Object.entries(devices)) live[deviceHex(account)] = ids.map(deviceHex)
    }
    return live
  }

  /**
   * Brings a group's members' devices in line with `live` (ADR-0022), one
   * commit at a time: additions first, so a restored account still has a
   * leaf when its lost devices are removed.
   */
  private async reconcileDevices(conversationId: string, live: Record<string, string[]>) {
    const { account, core } = this.ready()
    for (let round = 0; round < 4; round++) {
      const conv = this.state.conversations[conversationId]
      if (!conv || conv.status || this.state.pendingCommit || this.connection !== 'online') return
      const members = (core.members(fromHex(conversationId)) as Uint8Array[]).map((m) => {
        const { account, device } = splitIdentity(m)
        return { account, device: toHex(device) }
      })
      const plans = memberDevicePlan(members, live, deviceHex(account.deviceId))
      const adding = plans.find((p) => p.missing.length > 0)
      const removing = plans.filter((p) => p.stale.length > 0)
      let outcome: CommitOutcome | undefined
      if (adding) {
        const invitee = await this.deviceInvitee(adding.account, adding.missing)
        if (!invitee) return
        outcome = await this.exclusive(async () => {
          if (this.state.pendingCommit || this.connection !== 'online') return undefined
          await this.flushOutbox(true)
          const existing = this.recipients(conversationId)
          const added = core.addMembers(fromHex(conversationId), invitee.keyPackages, randomId(), randomId())
          const pending: PendingCommit = {
            conversationId,
            commitHash: toBase64(added.commitHash),
            invitees: [{ account: invitee.account, username: invitee.username, devices: invitee.devices }],
          }
          const welcome = { envelope: added.welcome, recipients: invitee.devices }
          return this.sendCommit(pending, added.commit, existing, welcome)
        })
      } else if (removing.length > 0) {
        outcome = await this.exclusive(async () => {
          if (this.state.pendingCommit || this.connection !== 'online') return undefined
          await this.flushOutbox(true)
          const everyone = this.recipients(conversationId)
          const identities = removing.flatMap((p) => p.stale.map((d) => fromHex(p.account + d)))
          const staged = core.removeMembers(fromHex(conversationId), identities, randomId())
          const pending: PendingCommit = { conversationId, commitHash: toBase64(staged.commitHash) }
          return this.sendCommit(pending, staged.commit, everyone)
        })
      }
      if (outcome !== 'accepted') return
    }
  }

  /** Claims key packages for some of this account's devices (hex ids). */
  private ownInvitee(devices: string[]): Promise<Invitee | undefined> {
    return this.deviceInvitee(this.myAccount(), devices)
  }

  /** Claims key packages for some devices (hex ids) of an account. */
  private async deviceInvitee(account: string, devices: string[]): Promise<Invitee | undefined> {
    const { account: me } = this.ready()
    if (devices.length === 0) return undefined
    const claimed = await api.claim(me.token, devices)
    const packages = new Map(Object.entries(claimed.key_packages).map(([id, kp]) => [deviceHex(id), kp]))
    const found = devices.filter((d) => packages.has(d))
    if (found.length === 0) return undefined
    return {
      username: account === this.myAccount() ? me.username : (this.state.usernames[account] ?? ''),
      account,
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
      await this.observeKeysIn(id)
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
      usernames: this.state.usernames,
      blocked: this.state.blocked,
      conversations: Object.fromEntries(
        Object.values(this.state.conversations)
          .filter((c) => !c.self && !c.status && !c.request)
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
    if (sync.blocked) this.state.blocked = sync.blocked
    this.state.names = { ...sync.names, ...this.state.names }
    this.state.usernames = { ...sync.usernames, ...this.state.usernames }
    for (const [id, meta] of Object.entries(sync.conversations)) {
      const target = this.state.conversations[id]
      if (target) {
        this.applyMeta(target, meta)
        target.request = undefined
      } else this.state.syncedMeta[id] = meta
    }
    for (const c of Object.values(this.state.conversations)) this.emit({ type: 'messages', conversationId: c.id })
    this.emitView()
  }

  private applyMeta(conv: Conversation, meta: { name?: string; admins?: string[] }) {
    if (conv.name === undefined && meta.name) conv.name = meta.name
    if ((conv.admins ?? []).length === 0 && meta.admins?.length) conv.admins = meta.admins
  }

  // ---- key packages ------------------------------------------------------------

  /**
   * Keeps enough key packages on the server for others to start chats with
   * this device: they are used up by claims, including lookups that never
   * lead to a chat, and expire after 30 days.
   */
  private async replenishKeyPackages(known?: number) {
    if (this.replenishing || !this.account) return
    this.replenishing = true
    try {
      const token = this.account.token
      const available = known ?? (await api.keyCount(token)).available
      const count = keyPackagesToUpload(available)
      if (count === 0) return
      const packages = await this.exclusive(async () => {
        const fresh = this.core!.keyPackages(count) as Uint8Array[]
        // Their private keys must be stored before anyone can use them.
        await this.persist()
        return fresh
      })
      await api.uploadKeyPackages(token, packages.map(toBase64))
    } catch (e) {
      console.warn('key package top-up failed', e)
    } finally {
      this.replenishing = false
    }
  }

  // ---- receipts (FR-MSG-5) -------------------------------------------------

  /** Marks received messages seen; sends read receipts if enabled. */
  async markRead(conversationId: string) {
    // Under the lock: the read-modify-write of the message list must not
    // interleave with a delivery appending to it.
    const changed = await this.exclusive(async () => {
      const conv = this.state.conversations[conversationId]
      if (!conv) return false
      const list = await this.stored(conversationId)
      const unseen = list.filter((m) => m.status === 'received' && !m.seen && m.kind !== 'notice')
      if (unseen.length === 0 && !conv.unread) return false
      for (const m of unseen) m.seen = true
      await this.store.putJson(`messages:${conversationId}`, list)
      conv.unread = 0
      await this.persist()
      if (!conv.request && this.state.readReceipts) {
        for (const m of unseen) this.queueReceipt(conversationId, 'read', m.id)
      }
      return true
    })
    if (changed) this.emitView()
  }

  async setMedia(media: MediaSettings) {
    await this.exclusive(async () => {
      this.state.media = { ...DEFAULT_MEDIA, ...media }
      await this.persist()
    })
    this.emitView()
  }

  async setReadReceipts(on: boolean) {
    await this.exclusive(async () => {
      this.state.readReceipts = on
      await this.persist()
    })
    this.emitView()
  }

  /** Batches receipts briefly so a burst of messages costs one envelope. */
  private queueReceipt(conversationId: string, kind: 'delivered' | 'read', messageId: string) {
    const entry = this.receipts.get(conversationId) ?? { delivered: [], read: [] }
    entry[kind].push(messageId)
    this.receipts.set(conversationId, entry)
    clearTimeout(this.receiptTimer)
    this.receiptTimer = setTimeout(() => void this.sendReceipts(), 300)
  }

  private async sendReceipts() {
    const batch = [...this.receipts]
    this.receipts.clear()
    await this.exclusive(async () => {
      for (const [conversationId, { delivered, read }] of batch) {
        const conv = this.state.conversations[conversationId]
        if (!conv || conv.status) continue
        const recipients = this.recipients(conversationId)
        if (recipients.length === 0) continue
        for (const [isRead, ids] of [
          [false, delivered],
          [true, read],
        ] as const) {
          if (ids.length === 0) continue
          const messageId = randomId()
          const envelope = this.core!.sendReceipt(
            fromHex(conversationId),
            isRead,
            ids.map(fromHex),
            Date.now(),
            messageId,
          )
          this.state.outbox.push({
            messageId: toHex(messageId),
            conversationId,
            envelope: toBase64(envelope),
            recipients,
            silent: true,
          })
        }
      }
      await this.persist()
    })
    void this.flushOutbox()
  }

  /** Updates our messages with receipts from `account`. */
  private async applyReceipts(conversationId: string, account: string, read: boolean, flat: Uint8Array) {
    const ids = new Set(splitIds(flat, toHex))
    const peers = this.state.conversations[conversationId]?.peers ?? []
    const list = await this.stored(conversationId)
    let changed = false
    for (const m of list) {
      if (m.from === 'me' && ids.has(m.id)) {
        applyReceipt(m, account, read, peers)
        changed = true
      }
    }
    if (!changed) return
    await this.store.putJson(`messages:${conversationId}`, list)
    this.emit({ type: 'messages', conversationId })
  }

  // ---- blocking and reporting (FR-ID-8) --------------------------------------

  async block(account: string) {
    await this.setBlocked([...new Set([...this.state.blocked, account])])
  }

  async unblock(account: string) {
    await this.setBlocked(this.state.blocked.filter((a) => a !== account))
  }

  blockedContacts() {
    return this.state.blocked.map((account) => ({ account, name: this.nameOf(account) }))
  }

  /** Sends a report; the server sees only the messages included here. */
  async report(
    conversationId: string,
    account: string,
    reason: 'spam' | 'harassment' | 'other',
    includeMessages: boolean,
  ) {
    const recent = includeMessages
      ? (await this.stored(conversationId))
          .filter((m) => m.from === account && m.kind !== 'notice')
          .slice(-10)
          .map((m) => ({ text: m.text, sent_at_ms: m.sentAt }))
      : []
    await api.report(this.ready().account.token, { account_id: account, reason, messages: recent })
  }

  private async setBlocked(blocked: string[]) {
    await this.exclusive(async () => {
      this.state.blocked = blocked
      const self = Object.values(this.state.conversations).find((c) => c.self && !c.status)
      if (self) this.queueDeviceSync(self.id)
      await this.persist()
    })
    this.emitView()
    void this.flushOutbox()
  }

  /**
   * A 1:1 chat with someone blocked that never had a message: typically
   * one they started after being blocked, so it stays out of the list.
   */
  private isBlockedChat(c: Conversation): boolean {
    if (c.request && c.peers.some((p) => this.state.blocked.includes(p))) return true
    return c.name === undefined && c.peers.length === 1 && this.state.blocked.includes(c.peers[0]) && !c.lastText
  }

  /** Moves a message request into the conversation list (FR-SAF-3). */
  async acceptRequest(conversationId: string) {
    const conv = this.group(conversationId)
    await this.exclusive(async () => {
      conv.request = undefined
      await this.persist()
    })
    // Receipts were held while it was a request.
    for (const m of await this.stored(conversationId)) {
      if (m.status === 'received') this.queueReceipt(conversationId, 'delivered', m.id)
    }
    this.emitView()
  }

  /**
   * Whether this user has a connection to `account`: looked them up, or
   * shares an accepted conversation with them.
   */
  private isKnown(account: string, except: string): boolean {
    if (account === this.myAccount() || this.state.usernames[account]) return true
    return Object.values(this.state.conversations).some(
      (c) => c.id !== except && !c.request && !c.self && c.peers.includes(account),
    )
  }

  // ---- safety numbers (ADR-0020) ---------------------------------------------

  /** The safety number with `account`, from the keys in a shared conversation. */
  safetyNumber(conversationId: string, account: string): SafetyNumber {
    const { mine, theirs } = this.keysIn(conversationId, account)
    if (theirs.length === 0) throw new Error('They are not in this conversation')
    const digits = safetyNumber(fromHex(this.myAccount()), mine.map(fromHex), fromHex(account), theirs.map(fromHex))
    const qr = encodeQr(verifyText(digits))
    const result = { digits, qrSize: qr.size, qrModules: Array.from(qr.modules) }
    qr.free()
    return result
  }

  /** Marks the contact verified with the keys their safety number covers. */
  async markVerified(conversationId: string, account: string) {
    const { theirs } = this.keysIn(conversationId, account)
    if (theirs.length === 0) throw new Error('They are not in this conversation')
    await this.exclusive(async () => {
      this.state.verified[account] = [...theirs].sort()
      await this.persist()
    })
    this.emitView()
  }

  /** Verifies by their scanned QR code; throws if it doesn't match. */
  async verifyScanned(conversationId: string, account: string, scanned: string) {
    if (!scannedMatches(scanned, this.safetyNumber(conversationId, account).digits)) {
      throw new Error("The codes don't match. Compare the numbers, and don't mark them verified.")
    }
    await this.markVerified(conversationId, account)
  }

  async dismissAlert(id: string) {
    await this.exclusive(async () => {
      this.state.alerts = this.state.alerts.filter((a) => a.id !== id)
      await this.persist()
    })
    this.emitView()
  }

  private verificationOf(account: string) {
    return verification(this.state.verified[account], this.state.keys[account])
  }

  /** Signature keys (hex) of this account's and `account`'s members in a group. */
  private keysIn(conversationId: string, account: string): { mine: string[]; theirs: string[] } {
    const me = this.myAccount()
    const mine: string[] = []
    const theirs: string[] = []
    for (const [identity, key] of this.core!.memberKeys(fromHex(conversationId)) as Uint8Array[][]) {
      const owner = splitIdentity(identity).account
      if (owner === me) mine.push(toHex(key))
      else if (owner === account) theirs.push(toHex(key))
    }
    return { mine, theirs }
  }

  /**
   * Records the device keys in a group's current roster and warns about
   * keys never seen before for a known account (FR-ID-6).
   */
  private async observeKeysIn(conversationId: string) {
    const me = this.myAccount()
    const byAccount = new Map<string, { keys: string[]; devices: Map<string, string> }>()
    for (const [identity, key] of this.core!.memberKeys(fromHex(conversationId)) as Uint8Array[][]) {
      const { account, device } = splitIdentity(identity)
      const entry = byAccount.get(account) ?? { keys: [] as string[], devices: new Map<string, string>() }
      entry.keys.push(toHex(key))
      entry.devices.set(toHex(key), toHex(device))
      byAccount.set(account, entry)
    }
    for (const [account, { keys, devices }] of byAccount) {
      const added = observeKeys(this.state.keys, account, keys)
      if (added.length === 0) continue
      if (account === me) {
        const expected = () => added.every((k) => this.state.expectedOwn.includes(devices.get(k) ?? ''))
        // The device being approved here can join our groups (member device
        // sync) before the approval loop hears its id: ask now.
        if (!expected() && this.approving) await this.expectLinkedDevice(this.approving).catch(() => false)
        if (expected()) continue
        this.state.alerts.push({
          id: toHex(randomId()),
          text: `A new device was added to your account on ${new Date().toLocaleDateString()}. If this wasn't you, remove it in Linked devices.`,
        })
        this.emitView()
        continue
      }
      const text = `${this.nameOf(account)}'s safety number changed: a device was added.`
      for (const c of Object.values(this.state.conversations)) {
        if (!c.self && c.peers.includes(account)) {
          await this.appendMessage(c.id, {
            id: toHex(randomId()),
            from: '',
            kind: 'notice',
            text,
            sentAt: Date.now(),
            status: 'received',
          })
        }
      }
    }
  }

  // ---- conversations -------------------------------------------------------

  async startChat(name: string): Promise<string> {
    const { account, core } = this.ready()
    const username = name.trim().toLowerCase()
    if (username === account.username) throw new Error("You can't start a chat with yourself")
    const found = await api.lookup(account.token, username)
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
      this.state.usernames[peer] = username
      this.state.conversations[id] = { id, peers: [peer], lastAt: Date.now() }
      await this.observeKeysIn(id)
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
  async createGroup(name: string, usernames: string[]): Promise<string> {
    const { core } = this.ready()
    const groupName = name.trim().slice(0, 64)
    if (!groupName) throw new Error('Give the group a name')
    const invitees = await this.resolve(usernames)
    if (invitees.length === 0) throw new Error('Add at least one other person')
    if (invitees.length + 1 > MAX_GROUP_MEMBERS) throw new Error(`Groups are limited to ${MAX_GROUP_MEMBERS} people`)
    const own = await this.otherOwnDevices()
    const everyone = own ? [...invitees, own] : invitees

    const id = await this.exclusive(async () => {
      const started = core.startConversation(
        everyone.flatMap((i) => i.keyPackages),
        randomId(),
      )
      const id = toHex(started.conversationId)
      for (const i of invitees) this.state.usernames[i.account] = i.username
      const admins = [this.myAccount()]
      this.state.conversations[id] = {
        id,
        peers: invitees.map((i) => i.account),
        name: groupName,
        admins,
        lastAt: Date.now(),
      }
      await this.observeKeysIn(id)
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
  async addMembers(conversationId: string, usernames: string[]) {
    const { core } = this.ready()
    const conv = this.state.conversations[conversationId]
    if (!conv) throw new Error('Unknown conversation')
    if (this.connection !== 'online') throw new Error('You need to be online to add people')
    if (this.state.pendingCommit) throw new Error('Still finishing an earlier group change; try again shortly')
    const invitees = (await this.resolve(usernames)).filter((i) => !conv.peers.includes(i.account))
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
        invitees: invitees.map(({ account, username, devices }) => ({ account, username, devices })),
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
      name: account === me ? this.account!.displayName || this.account!.username : this.nameOf(account),
      isAdmin: (conv.admins ?? []).includes(account),
      isMe: account === me,
      verification: account === me ? undefined : this.verificationOf(account),
      blocked: this.state.blocked.includes(account),
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
      this.state.live = this.state.live.filter((l) => l.conversationId !== conversationId)
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

  /** Messages for the UI: sender names resolved, attachment keys left out. */
  async messages(conversationId: string): Promise<ChatMessage[]> {
    const now = Date.now()
    return (await this.stored(conversationId)).map(({ file, ...m }) => ({
      ...m,
      // An ended session shows no point, even before the sweep forgets it.
      live: m.live && (m.live.ended || m.live.expiresAt <= now ? { ...m.live, ended: true, latest: undefined } : m.live),
      fromName: m.from === 'me' || m.kind === 'notice' ? undefined : this.nameOf(m.from),
      file: file && {
        name: file.name,
        mime: file.mime,
        size: file.size,
        width: file.width,
        height: file.height,
        thumbnail: file.thumbnail ? plain(fromBase64(file.thumbnail)) : undefined,
        durationMs: file.durationMs,
        voiceNote: file.voiceNote,
        downloaded: file.downloaded,
      },
    }))
  }

  private async stored(conversationId: string): Promise<StoredMessage[]> {
    return (await this.store.getJson<StoredMessage[]>(`messages:${conversationId}`)) ?? []
  }

  private checkCanSend(conversationId: string) {
    if (this.state.pendingCommit?.conversationId === conversationId) {
      throw new Error('Finishing a group change; try again when you are back online')
    }
    if (this.state.conversations[conversationId]?.status) throw new Error("You're no longer in this group")
  }

  /** Shares a location once (FR-LOC-1); it travels only inside MLS. */
  async sendLocation(conversationId: string, location: LocationInfo) {
    const { core } = this.ready()
    this.checkCanSend(conversationId)
    const checked = safeLocation(location.latitude, location.longitude, location.accuracyM, location.label ?? '')
    if (!checked) throw new Error("That location doesn't look right")
    await this.exclusive(async () => {
      const message: StoredMessage = {
        id: toHex(randomId()),
        from: 'me',
        text: '',
        sentAt: Date.now(),
        status: 'sending',
        location: checked,
      }
      const envelope = this.encode(core, conversationId, message)
      this.state.outbox.push({
        messageId: message.id,
        conversationId,
        envelope: toBase64(envelope),
        recipients: this.recipients(conversationId),
      })
      await this.appendMessage(conversationId, message)
      await this.persist()
    })
    void this.flushOutbox()
  }

  // ---- live location (FR-LOC-2/3/6, doc 06 §2) --------------------------------

  /** Starts sharing in one conversation for 15 min, 1 h or 8 h, from `location`. */
  async startLive(conversationId: string, durationMs: number, location: LocationInfo) {
    const { core } = this.ready()
    this.checkCanSend(conversationId)
    if (!(LIVE_DURATIONS_MS as readonly number[]).includes(durationMs)) throw new Error('Choose 15 minutes, 1 hour or 8 hours')
    const point = safeLocation(location.latitude, location.longitude, location.accuracyM, '')
    if (!point) throw new Error("That location doesn't look right")
    await this.stopLive(conversationId)
    await this.exclusive(async () => {
      const now = Date.now()
      const session: LiveSession = {
        sessionId: toHex(randomId()),
        conversationId,
        messageId: toHex(randomId()),
        expiresAt: now + durationMs,
        lastSentAt: now,
        last: point,
      }
      const message: StoredMessage = {
        id: session.messageId,
        from: 'me',
        text: '',
        sentAt: now,
        status: 'sending',
        live: { sessionId: session.sessionId, expiresAt: session.expiresAt, latest: { ...point, at: now }, ended: false },
      }
      this.state.outbox.push({
        messageId: message.id,
        conversationId,
        envelope: toBase64(this.encode(core, conversationId, message)),
        recipients: this.recipients(conversationId),
      })
      this.state.live.push(session)
      await this.appendMessage(conversationId, message)
      await this.persist()
    })
    this.scheduleLiveSweep()
    void this.flushOutbox()
  }

  /**
   * A new fix from the page. Each running session sends it if it moved
   * enough or a heartbeat is due, and only while online: updates queued
   * offline would arrive stale.
   */
  async liveUpdate(location: LocationInfo) {
    const point = safeLocation(location.latitude, location.longitude, location.accuracyM, '')
    if (!point) return
    // Kept for the sweep: the page reports only changes, so a move held back
    // by the rate floor, and the heartbeat, go out from there.
    this.liveFix = point
    if (this.connection !== 'online') return
    await this.endExpiredLive()
    let sent = false
    await this.exclusive(async () => {
      const { core } = this.ready()
      const now = Date.now()
      for (const session of this.state.live) {
        if (this.state.conversations[session.conversationId]?.status) continue
        if (!updateDue(now, session.lastSentAt, session.last, point)) continue
        const messageId = randomId()
        const envelope = core.sendLiveLocation(
          fromHex(session.conversationId),
          fromHex(session.sessionId),
          session.expiresAt,
          true,
          point.latitude,
          point.longitude,
          point.accuracyM,
          now,
          messageId,
        )
        this.state.outbox.push({
          messageId: toHex(messageId),
          conversationId: session.conversationId,
          envelope: toBase64(envelope),
          recipients: this.recipients(session.conversationId),
          // Moving a pin is nothing to wake a phone for.
          silent: true,
        })
        session.lastSentAt = now
        session.last = point
        await this.setLivePoint(session.conversationId, session.messageId, { ...point, at: now })
        sent = true
      }
      if (sent) await this.persist()
    })
    if (sent) void this.flushOutbox()
  }

  /** Stops sharing in a conversation now, telling the others. */
  async stopLive(conversationId: string) {
    const session = this.state.live.find((l) => l.conversationId === conversationId)
    if (!session) return
    await this.exclusive(async () => {
      this.state.live = this.state.live.filter((l) => l !== session)
      await this.endLiveMessage(conversationId, session.messageId)
      const conv = this.state.conversations[conversationId]
      if (this.core && conv && !conv.status && session.expiresAt > Date.now()) {
        const messageId = randomId()
        const envelope = this.core.sendLiveLocation(
          fromHex(conversationId),
          fromHex(session.sessionId),
          session.expiresAt,
          false,
          0,
          0,
          0,
          Date.now(),
          messageId,
        )
        this.state.outbox.push({
          messageId: toHex(messageId),
          conversationId,
          envelope: toBase64(envelope),
          recipients: this.recipients(conversationId),
          silent: true,
        })
      }
      await this.persist()
    })
    this.emitView()
    void this.flushOutbox()
  }

  // ---- calls (ADR-0028) ----------------------------------------------------

  /** STUN and TURN servers for a call, with fresh TURN credentials. */
  async iceServers(): Promise<IceServer[]> {
    const { ice_servers } = await api.iceServers(this.ready().account.token)
    return ice_servers
  }

  /**
   * Sends a signal from the call screen. Offers wake the other person's
   * devices; everything else is silent. Candidates and busy go only to the
   * device they are for; the rest reach every device in the conversation,
   * so this user's other devices stop ringing once one of them answers.
   */
  async callSignal(conversationId: string, signal: CallSignal) {
    const conv = this.group(conversationId)
    if (conv.status || conv.self || conv.peers.length !== 1) throw new Error('Calls work in one-to-one chats')
    if (this.state.blocked.includes(conv.peers[0])) throw new Error('Unblock this contact to call them')
    if (this.connection !== 'online') throw new Error("You're offline")
    const kind = CALL_KINDS.indexOf(signal.kind)
    if (kind < 0) throw new Error('Unknown call signal')
    await this.exclusive(async () => {
      const { core } = this.ready()
      const messageId = randomId()
      const now = Date.now()
      const envelope = core.sendCall(
        fromHex(conversationId),
        fromHex(signal.callId),
        kind,
        signal.sdp ?? '',
        signal.candidate ?? '',
        signal.video ?? false,
        signal.toDevice ? fromHex(signal.toDevice) : new Uint8Array(),
        now,
        messageId,
      )
      const direct = signal.toDevice && (signal.kind === 'candidate' || signal.kind === 'busy')
      this.state.outbox.push({
        messageId: toHex(messageId),
        conversationId,
        envelope: toBase64(envelope),
        recipients: direct ? [signal.toDevice!] : this.recipients(conversationId),
        silent: signal.kind !== 'offer',
      })
      await this.trackCall(conversationId, signal, true, true, now)
      await this.persist()
    })
    void this.flushOutbox()
  }

  /** A signal from the other person or another of our devices (under the lock). */
  private async applyCall(conv: Conversation, mine: boolean, device: string, sentAt: number, signal: CallSignal) {
    const now = Date.now()
    const thisDevice = deviceHex(this.ready().account.deviceId)
    const forThis = !signal.toDevice || signal.toDevice === thisDevice
    const known = this.calls.get(signal.callId)
    if (known && known.conversationId !== conv.id) return
    if (signal.kind === 'offer' && known) return
    if (signal.kind !== 'offer' && !known) return
    if ((signal.kind === 'candidate' || signal.kind === 'busy') && !forThis) return
    const outgoing = known?.outgoing ?? mine
    await this.trackCall(conv.id, signal, mine, false, now)
    if (signal.kind === 'offer' && !mine && (now - sentAt > STALE_OFFER_MS || conv.request)) {
      // Delivered too late to ring, or from someone not accepted yet.
      await this.endCall(signal.callId, 'timeout', false)
      return
    }
    // Calls placed on another of our devices are that device's business;
    // for calls to us, our other devices' answers stop the ringing here.
    if (outgoing && mine) return
    if (!mine && !forThis) return
    this.emit({
      type: 'call',
      signal: { ...signal, conversationId: conv.id, title: this.title(conv), fromDevice: device, elsewhere: mine },
    })
  }

  /** Keeps the call log up to date with a signal sent or received (under the lock). */
  private async trackCall(conversationId: string, signal: CallSignal, mine: boolean, here: boolean, now: number) {
    const call = this.calls.get(signal.callId)
    if (signal.kind === 'offer') {
      if (call) return
      this.calls.set(signal.callId, { conversationId, outgoing: mine, video: !!signal.video, startedAt: now })
      this.callTimer ??= setInterval(() => void this.sweepCalls(), 15_000)
      return
    }
    if (!call) return
    if (signal.kind === 'answer') {
      call.answeredAt ??= now
      if (mine && !here && !call.outgoing) call.elsewhere = 'answered'
    } else if (signal.kind === 'decline') {
      if (mine && !here && !call.outgoing) call.elsewhere = 'declined'
      await this.endCall(signal.callId, 'decline', mine)
    } else if (signal.kind === 'hangup' || signal.kind === 'busy') {
      await this.endCall(signal.callId, signal.kind, mine)
    }
  }

  /** Leaves a notice for a call that ended (under the lock). */
  private async endCall(callId: string, end: CallEnd, byMe: boolean) {
    const call = this.calls.get(callId)
    if (!call) return
    this.calls.delete(callId)
    const conv = this.state.conversations[call.conversationId]
    if (!conv) return
    const now = Date.now()
    const { text, missed } = callNotice(call, end, byMe, now)
    await this.appendMessage(call.conversationId, {
      id: toHex(randomId()),
      from: '',
      kind: 'notice',
      text,
      sentAt: now,
      status: 'received',
    })
    if (missed) {
      conv.unread = (conv.unread ?? 0) + 1
      conv.lastText = text
      conv.lastAt = Math.max(conv.lastAt, now)
      this.emitView()
    }
  }

  /** Unanswered calls nobody hung up end as missed. */
  private async sweepCalls() {
    const now = Date.now()
    const due = [...this.calls].filter(([, c]) => c.answeredAt === undefined && now - c.startedAt > GIVE_UP_MS)
    if (due.length > 0) {
      await this.exclusive(async () => {
        for (const [id] of due) await this.endCall(id, 'timeout', false)
        await this.persist()
      })
    }
    if (this.calls.size === 0) {
      clearInterval(this.callTimer)
      this.callTimer = undefined
    }
  }

  /** Moves the point shown on a live message (under the lock). */
  private async setLivePoint(conversationId: string, messageId: string, latest: LocationInfo & { at: number }) {
    const list = await this.stored(conversationId)
    const message = list.find((m) => m.id === messageId)
    if (!message?.live || message.live.ended) return
    message.live.latest = latest
    await this.store.putJson(`messages:${conversationId}`, list)
    this.emit({ type: 'messages', conversationId })
  }

  /** Ends a live message and forgets its point (doc 06: discard at the end). Under the lock. */
  private async endLiveMessage(conversationId: string, messageId: string) {
    const list = await this.stored(conversationId)
    const message = list.find((m) => m.id === messageId)
    if (!message?.live || message.live.ended) return
    message.live.ended = true
    message.live.latest = undefined
    await this.store.putJson(`messages:${conversationId}`, list)
    this.emit({ type: 'messages', conversationId })
  }

  /** Ends our sessions that ran out, and forgets the points of others' that did. */
  private async endExpiredLive() {
    const now = Date.now()
    const due =
      this.state.live.some((l) => l.expiresAt <= now) || this.state.liveSeen.some((l) => l.expiresAt <= now)
    if (!due) return
    await this.exclusive(async () => {
      for (const l of [...this.state.live, ...this.state.liveSeen].filter((l) => l.expiresAt <= now)) {
        await this.endLiveMessage(l.conversationId, l.messageId)
      }
      this.state.live = this.state.live.filter((l) => l.expiresAt > now)
      this.state.liveSeen = this.state.liveSeen.filter((l) => l.expiresAt > now)
      await this.persist()
    })
    this.emitView()
  }

  private scheduleLiveSweep() {
    this.liveTimer ??= setInterval(() => {
      if (this.liveFix && this.state.live.length > 0) void this.liveUpdate(this.liveFix)
      else void this.endExpiredLive()
      if (this.state.live.length === 0 && this.state.liveSeen.length === 0) {
        clearInterval(this.liveTimer)
        this.liveTimer = undefined
      }
    }, 15_000)
  }

  /** A received live-location start, update or stop (under the lock). */
  private async applyLive(
    conversationId: string,
    from: string,
    mine: boolean,
    messageId: string,
    sentAt: number,
    view: LiveLocationView,
  ) {
    const sessionId = view.sessionId.length === 16 ? toHex(view.sessionId) : undefined
    const place = view.location
    const point = place && safeLocation(place.latitude, place.longitude, place.accuracyM, '')
    place?.free()
    if (!sessionId || !plausibleExpiry(view.expiresAtMs, sentAt)) return
    const list = await this.stored(conversationId)
    const sender = mine ? 'me' : from
    // Only the session's own sender can move or stop it.
    const shown = list.find((m) => m.live?.sessionId === sessionId && m.from === sender)
    if (shown?.live) {
      if (shown.live.ended) return
      if (view.stopped) await this.endLiveMessage(conversationId, shown.id)
      else if (point && sentAt > (shown.live.latest?.at ?? 0)) await this.setLivePoint(conversationId, shown.id, { ...point, at: sentAt })
      return
    }
    if (view.stopped || !point) return
    const ended = view.expiresAtMs <= Date.now()
    const conv = this.state.conversations[conversationId]
    if (!mine && conv) {
      conv.unread = (conv.unread ?? 0) + 1
      if (!conv.request) this.queueReceipt(conversationId, 'delivered', messageId)
    }
    await this.appendMessage(conversationId, {
      id: messageId,
      from: sender,
      text: '',
      sentAt,
      status: mine ? 'sent' : 'received',
      live: { sessionId, expiresAt: view.expiresAtMs, latest: ended ? undefined : { ...point, at: sentAt }, ended },
    })
    if (!ended) {
      this.state.liveSeen.push({ conversationId, messageId, expiresAt: view.expiresAtMs })
      this.scheduleLiveSweep()
    }
  }

  async sendText(conversationId: string, text: string) {
    const { core } = this.ready()
    this.checkCanSend(conversationId)
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

  /**
   * Sends a message again after it failed for good: re-encrypted for the
   * group as it is now, under the same message id.
   */
  async retryMessage(conversationId: string, messageId: string) {
    const { core } = this.ready()
    const conv = this.group(conversationId)
    if (conv.status) throw new Error("You're no longer in this conversation")
    const failed = (await this.stored(conversationId)).find((m) => m.id === messageId && m.status === 'failed')
    if (failed?.file && !failed.file.blobId) {
      // The upload failed: start over from the sealed copy kept here.
      await this.exclusive(() => this.setStatus(conversationId, messageId, 'sending'))
      void this.uploadAndSend(conversationId, messageId)
      return
    }
    await this.exclusive(async () => {
      const list = await this.stored(conversationId)
      const message = list.find((m) => m.id === messageId && m.from === 'me' && m.status === 'failed')
      if (!message) return
      const envelope = this.encode(core, conversationId, message)
      this.state.outbox.push({
        messageId,
        conversationId,
        envelope: toBase64(envelope),
        recipients: this.recipients(conversationId),
      })
      message.status = 'sending'
      message.error = undefined
      await this.store.putJson(`messages:${conversationId}`, list)
      await this.persist()
    })
    this.emit({ type: 'messages', conversationId })
    void this.flushOutbox()
  }

  /** Encrypts one of our messages for the group as it is now. */
  private encode(core: CoreClient, conversationId: string, m: StoredMessage): Uint8Array {
    const id = fromHex(m.id)
    if (m.live) {
      const p = m.live.latest
      return core.sendLiveLocation(
        fromHex(conversationId),
        fromHex(m.live.sessionId),
        m.live.expiresAt,
        !!p,
        p?.latitude ?? 0,
        p?.longitude ?? 0,
        p?.accuracyM ?? 0,
        m.sentAt,
        id,
      )
    }
    if (m.location) {
      const l = m.location
      return core.sendLocation(fromHex(conversationId), l.latitude, l.longitude, l.accuracyM, l.label ?? '', m.sentAt, id)
    }
    if (!m.file) return core.sendText(fromHex(conversationId), m.text, m.sentAt, id)
    const f = m.file
    if (!f.blobId) throw new Error('not uploaded yet')
    const view = new AttachmentView(
      fromHex(f.blobId),
      fromBase64(f.key),
      fromBase64(f.digest),
      f.size,
      f.mime,
      f.name,
      f.width ?? 0,
      f.height ?? 0,
      f.thumbnail ? fromBase64(f.thumbnail) : new Uint8Array(),
      m.text,
      f.durationMs ?? 0,
      !!f.voiceNote,
    )
    try {
      return core.sendAttachment(fromHex(conversationId), view, m.sentAt, id)
    } finally {
      view.free()
    }
  }

  // ---- images and files (ADR-0024) -------------------------------------------

  /**
   * Sends a photo or file: photos are re-drawn without their metadata, the
   * file is sealed under a new key and kept here sealed, then uploaded; the
   * key goes to the group in an MLS message.
   */
  async sendFile(conversationId: string, file: File, caption: string, media?: MediaInfo) {
    this.ready()
    this.checkCanSend(conversationId)
    if (file.size === 0) throw new Error('That file is empty')
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Files can be up to 100 MB')
    const image = await prepareImage(file, this.state.media.quality)
    // Clips: where they were filmed is blanked (ADR-0024).
    const data = image?.data ?? (isMp4(file.type) ? await scrubMp4(file) : file)
    if (data.size > MAX_ATTACHMENT_BYTES) throw new Error('Files can be up to 100 MB')
    const key = crypto.getRandomValues(new Uint8Array(32))
    const sealed = await sealFile(data, key)
    const mime = image?.mime ?? safeMime(file.type)
    const clip = !image && isPlayable(mime) ? media : undefined
    const thumbnail = image?.thumbnail ?? (clip?.thumbnail && clip.thumbnail.length <= MAX_THUMB_BYTES ? clip.thumbnail : undefined)
    const size = image ? { width: image.width, height: image.height } : safeSize(clip?.width, clip?.height)
    const name = safeName(image && image.data !== file ? renamed(file.name, mime) : file.name)
    const messageId = toHex(randomId())
    await this.store.putFile(messageId, sealed.body)
    await this.exclusive(() =>
      this.appendMessage(conversationId, {
        id: messageId,
        from: 'me',
        text: caption,
        sentAt: Date.now(),
        status: 'sending',
        file: {
          name,
          mime,
          size: sealed.size,
          ...size,
          thumbnail: thumbnail?.length ? toBase64(thumbnail) : undefined,
          durationMs: safeDuration(clip?.durationMs),
          voiceNote: clip?.voiceNote && mime.startsWith('audio/') ? true : undefined,
          downloaded: true,
          key: toBase64(key),
          digest: toBase64(sealed.digest),
        },
      }),
    )
    void this.uploadAndSend(conversationId, messageId)
  }

  /** Remembers a transfer to resume, or forgets it (`add` false). */
  private async trackTransfer(conversationId: string, messageId: string, kind: 'upload' | 'download', add: boolean) {
    await this.exclusive(async () => {
      const others = this.state.transfers.filter((t) => t.messageId !== messageId)
      this.state.transfers = add ? [...others, { conversationId, messageId, kind }] : others
      await this.persist()
    })
  }

  /** Updates one stored attachment's details under the lock. */
  private async updateFile(conversationId: string, messageId: string, change: Partial<StoredFile>) {
    await this.exclusive(async () => {
      const list = await this.stored(conversationId)
      const message = list.find((m) => m.id === messageId)
      if (!message?.file) return
      Object.assign(message.file, change)
      await this.store.putJson(`messages:${conversationId}`, list)
    })
  }

  private progress(conversationId: string, messageId: string): transfers.Progress {
    return (done, total) => this.emit({ type: 'progress', conversationId, messageId, done, total })
  }

  /** Picks up uploads and downloads cut short by a reload or lost connection. */
  private resumeTransfers() {
    for (const t of this.state.transfers) {
      if (t.kind === 'upload') void this.uploadAndSend(t.conversationId, t.messageId)
      else void this.fetchAttachment(t.conversationId, t.messageId).catch(() => undefined)
    }
  }

  private async uploadAndSend(conversationId: string, messageId: string) {
    if (this.inflight.has(messageId)) return
    this.inflight.add(messageId)
    try {
      const { account } = this.ready()
      const pending = (await this.stored(conversationId)).find((m) => m.id === messageId)
      if (!pending?.file || pending.status !== 'sending') return this.trackTransfer(conversationId, messageId, 'upload', false)
      await this.trackTransfer(conversationId, messageId, 'upload', true)
      let blobId = pending.file.blobId
      if (!blobId) {
        const body = await this.store.getFile(messageId)
        if (!body) throw new Error('This file is no longer on this device')
        const session = {
          id: pending.file.uploadId,
          save: (uploadId: string | undefined) => this.updateFile(conversationId, messageId, { uploadId }),
        }
        blobId = uuidToHex(await transfers.upload(account.token, body, session, this.progress(conversationId, messageId)))
      }
      await this.exclusive(async () => {
        const { core } = this.ready()
        this.checkCanSend(conversationId)
        const list = await this.stored(conversationId)
        const message = list.find((m) => m.id === messageId)
        if (!message?.file || message.status !== 'sending') return
        message.file.blobId = blobId
        const envelope = this.encode(core, conversationId, message)
        this.state.outbox.push({
          messageId,
          conversationId,
          envelope: toBase64(envelope),
          recipients: this.recipients(conversationId),
        })
        await this.store.putJson(`messages:${conversationId}`, list)
        this.state.transfers = this.state.transfers.filter((t) => t.messageId !== messageId)
        await this.persist()
      })
      void this.flushOutbox()
    } catch (e) {
      if (this.connection !== 'online' && !(e instanceof ApiError)) return // resumes after reconnecting
      await this.trackTransfer(conversationId, messageId, 'upload', false)
      await this.exclusive(() => this.setStatus(conversationId, messageId, 'failed', describeError(e)))
    } finally {
      this.inflight.delete(messageId)
    }
  }

  /**
   * Downloads a message's sealed file to this device (resuming an earlier
   * attempt) unless it is already here.
   */
  private fetchAttachment(conversationId: string, messageId: string): Promise<Blob> {
    const running = this.downloads.get(messageId)
    if (running) return running
    const run = (async () => {
      const { account } = this.ready()
      const f = (await this.stored(conversationId)).find((m) => m.id === messageId)?.file
      if (!f) throw new Error('No such file')
      const kept = await this.store.getFile(messageId)
      if (kept) return kept
      if (!f.blobId) throw new Error('This file was not uploaded')
      const total = sealedLength(f.size)
      await this.trackTransfer(conversationId, messageId, 'download', true)
      try {
        const body = await transfers.download(
          account.token,
          hexToUuid(f.blobId),
          total,
          this.store,
          messageId,
          this.progress(conversationId, messageId),
        )
        await this.updateFile(conversationId, messageId, { downloaded: true })
        await this.trackTransfer(conversationId, messageId, 'download', false)
        this.emit({ type: 'messages', conversationId })
        return body
      } catch (e) {
        // Lost connection: kept to resume. Anything else (expired…): given up.
        if (e instanceof ApiError || this.connection === 'online') {
          await this.trackTransfer(conversationId, messageId, 'download', false)
        }
        throw e
      }
    })()
    this.downloads.set(messageId, run)
    void run.catch(() => undefined).finally(() => this.downloads.delete(messageId))
    return run
  }

  /**
   * The decrypted file of a message: from this device if it was sent or
   * opened here before, else downloaded (and kept sealed for next time).
   */
  async openAttachment(conversationId: string, messageId: string): Promise<Blob> {
    const message = (await this.stored(conversationId)).find((m) => m.id === messageId)
    const f = message?.file
    if (!f) throw new Error('No such file')
    const body = await this.fetchAttachment(conversationId, messageId)
    try {
      // Other types (SVG, HTML…) are never handed out as something a browser renders.
      const type = isPhoto(f.mime) || isPlayable(f.mime) ? f.mime : 'application/octet-stream'
      return await openFile(body, fromBase64(f.key), f.size, fromBase64(f.digest), type)
    } catch (e) {
      await this.store.putFile(messageId, undefined)
      await this.updateFile(conversationId, messageId, { downloaded: undefined })
      throw new Error(`This file could not be opened: ${describeError(e)}`)
    }
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
    this.keyCheckTimer ??= setInterval(() => {
      if (this.connection === 'online') void this.replenishKeyPackages()
    }, KEY_PACKAGE_CHECK_MS)
    this.backupTimer ??= setInterval(() => {
      if (this.connection === 'online' && this.backupDirty && this.state.backup) {
        this.backupNow().catch((e) => console.warn('backup failed', e))
      }
    }, BACKUP_INTERVAL_MS)
    // Members' devices change without telling us (restores, deletions).
    this.memberCheckTimer ??= setInterval(() => {
      if (this.connection === 'online') this.scheduleSync()
    }, MEMBER_CHECK_MS)
    ws.onmessage = (event) => this.onFrame(decodeServerFrame(new Uint8Array(event.data as ArrayBuffer)))
    ws.onclose = () => {
      if (this.ws !== ws) return // replaced or signed out
      this.ws = undefined
      for (const resolve of this.waiters.values()) resolve(undefined)
      this.waiters.clear()
      this.setConnection('offline')
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs)
      this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS)
    }
  }

  private onFrame(frame: ServerFrameView) {
    switch (frame.kind) {
      case 'auth':
        this.reconnectMs = 1000
        this.setConnection('online')
        void this.replenishKeyPackages(frame.keyPackages)
        // Queued before any delivery handler, so it settles first.
        void this.exclusive(() => this.resolvePendingCommit()).then(() => {
          this.commitDepartures()
          this.scheduleSync()
          this.resumeTransfers()
          return this.flushOutbox()
        })
        return
      case 'deliver':
        void this.onDeliver(frame)
        return
      case 'devices_changed':
        // A member restored, linked or lost a device (ADR-0022).
        this.scheduleSync()
        return
      default: {
        const waiter = this.waiters.get(frame.requestId)
        if (waiter) {
          this.waiters.delete(frame.requestId)
          waiter(frame)
        } else if (frame.kind === 'error' && frame.errorCode === 401 && this.connection !== 'online') {
          // Our token was refused: removed by another device, or the account was deleted.
          void this.signOut('This device is no longer signed in: it was removed, or the account was deleted.')
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
      const restored = this.state.conversations[conversationId]
      if (restored?.status === 'restoring') {
        // Re-added after a restore: keep the history and group details.
        restored.status = undefined
        restored.peers = this.peersOf(conversationId)
        await this.observeKeysIn(conversationId)
        this.queueProfile(conversationId)
        this.emitView()
        this.emit({ type: 'messages', conversationId })
        return
      }
      const conv: Conversation = { id: conversationId, peers: this.peersOf(conversationId), lastAt: Date.now() }
      const meta = this.state.syncedMeta[conversationId]
      if (meta) {
        // Known to another of our devices, so not a request.
        this.applyMeta(conv, meta)
        delete this.state.syncedMeta[conversationId]
      } else if (conv.peers.length > 0 && !conv.peers.some((p) => this.isKnown(p, conversationId))) {
        conv.request = true
      }
      this.state.conversations[conversationId] = conv
      await this.observeKeysIn(conversationId)
      this.scheduleSync()
      this.queueProfile(conversationId)
      // Joining consumed one of our key packages.
      void this.replenishKeyPackages()
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
      await this.observeKeysIn(conversationId)
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
      // Messages from earlier epochs still decrypt (for late delivery), so a
      // removed member could keep posting with the keys they last had. The
      // server can't read commits to stop them: drop what doesn't come from
      // a current member.
      const sender = toHex(event.sender)
      const current = (this.core!.members(event.conversationId) as Uint8Array[]).map(toHex)
      if (!current.includes(sender)) {
        console.warn('dropping a message from a former member')
        return
      }
      const from = splitIdentity(event.sender).account
      const conv = this.state.conversations[conversationId]
      const mine = from === this.myAccount()
      if (event.deviceSync !== undefined) {
        if (mine) await this.applyDeviceSync(conversationId, event.deviceSync)
        return
      }
      if (event.receiptKind !== undefined) {
        if (!mine && conv) await this.applyReceipts(conversationId, from, event.receiptKind === 1, event.receiptIds)
        return
      }
      if (event.groupName !== undefined && conv && acceptsGroupInfo(conv.admins, from)) {
        if (event.groupName) conv.name = event.groupName.slice(0, 64)
        const admins = parseAdmins(event.groupAdmins)
        if (admins.length > 0) conv.admins = admins
        this.emitView()
      }
      const callView = event.call
      if (callView) {
        const signal = parseCall(callView)
        callView.free()
        const oneToOne = conv && !conv.status && !conv.self && conv.peers.length === 1
        if (signal && oneToOne && !this.state.blocked.includes(from)) {
          const device = toHex(splitIdentity(event.sender).device)
          await this.applyCall(conv, mine, device, event.sentAtMs, signal)
        }
        return
      }
      const live = event.live
      if (live) {
        if (!conv?.status && !this.state.blocked.includes(from)) {
          await this.applyLive(conversationId, from, mine, messageId, event.sentAtMs, live)
        }
        live.free()
        return
      }
      const view = event.attachment
      const attachment = view && this.receivedFile(view)
      const place = event.location
      const location = place && safeLocation(place.latitude, place.longitude, place.accuracyM, place.label)
      place?.free()
      // An unusable attachment is dropped with its caption, and a bad location with it.
      const text = view ? attachment && view.caption : place ? location && '' : event.text
      view?.free()
      if (conv?.status && text !== undefined) return // no longer in the group
      if (this.state.blocked.includes(from)) return // blocked (FR-ID-8)
      if (event.displayName !== undefined && !mine) {
        this.state.names[from] = event.displayName.slice(0, 64)
        this.emitView()
        // Sender names are resolved when messages are read: refresh lists.
        for (const c of Object.values(this.state.conversations)) {
          if (c.peers.includes(from)) this.emit({ type: 'messages', conversationId: c.id })
        }
      }
      if (text !== undefined) {
        if (!mine && conv) {
          conv.unread = (conv.unread ?? 0) + 1
          if (!conv.request) this.queueReceipt(conversationId, 'delivered', messageId)
        }
        // Sent from another of our devices: show it as ours.
        await this.appendMessage(conversationId, {
          id: messageId,
          from: mine ? 'me' : from,
          text,
          sentAt: event.sentAtMs,
          status: mine ? 'sent' : 'received',
          file: attachment,
          location,
        })
        if (attachment && autoDownloads(this.state.media, attachment.mime, onMobileData())) {
          // After this delivery is stored: the download takes the lock to record itself.
          void this.fetchAttachment(conversationId, messageId).catch((e) => console.warn('download failed', e))
        }
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
          encodeSend(id, fromBase64(item.envelope), item.recipients.map(fromHex), item.silent ?? false),
        )
        if (!result) return // disconnected: retry after reconnecting
        let outcome = sendOutcome(result)
        if (outcome.kind === 'retry') {
          item.attempts = (item.attempts ?? 0) + 1
          if (item.attempts <= MAX_SEND_RETRIES) {
            // Keep it queued and try again later, in order.
            clearTimeout(this.retryTimer)
            this.retryTimer = setTimeout(() => void this.flushOutbox(), retryDelay(item.attempts - 1))
            return
          }
          outcome = { kind: 'failed', reason: "Couldn't reach the server" }
        }
        if (outcome.kind === 'failed') console.warn('send failed', result.errorCode, result.errorMessage)
        const settle = async () => {
          this.state.outbox.shift()
          if (outcome.kind === 'failed')
            await this.setStatus(item.conversationId, item.messageId, 'failed', outcome.reason)
          else await this.setStatus(item.conversationId, item.messageId, 'sent')
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
      // A connection that stops answering is replaced; the request counts
      // as lost and whatever sent it retries after reconnecting.
      const timeout = setTimeout(() => {
        if (!this.waiters.delete(id)) return
        resolve(undefined)
        console.warn('request timed out; reconnecting')
        ws.close()
      }, REQUEST_TIMEOUT_MS)
      this.waiters.set(id, (frame) => {
        clearTimeout(timeout)
        resolve(frame)
      })
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
        : encodeSend(requestId, commit, recipients.map(fromHex), false),
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
    if (conv && !conv.self) conv.peers = this.peersOf(p.conversationId)
    if (conv) await this.observeKeysIn(p.conversationId)
    if (!this.core!.hasPendingProposals(fromHex(p.conversationId))) delete this.state.leaving[p.conversationId]
    if (p.invitees && conv?.self) {
      this.queueDeviceSync(p.conversationId)
    } else if (p.invitees) {
      for (const i of p.invitees) {
        if (i.account !== this.myAccount() && i.username) this.state.usernames[i.account] = i.username
      }
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

  /** Resolves username numbers to accounts and claims a key package per device. */
  private async resolve(usernames: string[]): Promise<Invitee[]> {
    const { account } = this.ready()
    const unique = [...new Set(usernames.map((p) => p.trim().toLowerCase()).filter(Boolean))].filter(
      (p) => p !== account.username,
    )
    const found = await Promise.all(
      unique.map(async (username) => {
        try {
          return { username, ...(await api.lookup(account.token, username)) }
        } catch (e) {
          throw new Error(`${username}: ${describeError(e)}`)
        }
      }),
    )
    const claimed = await api.claim(
      account.token,
      found.flatMap((f) => f.device_ids),
    )
    return found.map((f) => {
      const devices = f.device_ids.filter((d) => claimed.key_packages[d])
      if (devices.length === 0) throw new Error(`${f.username} has no keys available right now; try again later`)
      return {
        username: f.username,
        account: f.account_id.replaceAll('-', ''),
        devices: devices.map((d) => d.replaceAll('-', '')),
        keyPackages: devices.map((d) => fromBase64(claimed.key_packages[d])),
      }
    })
  }

  private queueGroupInfo(conversationId: string, name: string, admins: string[]) {
    const messageId = randomId()
    const envelope = this.core!.sendGroupInfo(fromHex(conversationId), name, admins.map(fromHex), Date.now(), messageId)
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
    return this.state.names[account] ?? this.state.usernames[account] ?? 'New contact'
  }

  private title(c: Conversation): string {
    return c.name ?? (c.peers.map((p) => this.nameOf(p)).join(', ') || 'Just you')
  }

  /** Checks an attachment from the wire; undefined if it is unusable. */
  private receivedFile(a: AttachmentView): StoredFile | undefined {
    if (a.blobId.length !== 16 || a.key.length !== 32 || a.digest.length !== 32) return undefined
    if (!(a.size > 0 && a.size <= MAX_ATTACHMENT_BYTES)) return undefined
    const thumbnail = a.thumbnail
    const mime = safeMime(a.mime)
    return {
      blobId: toHex(a.blobId),
      key: toBase64(a.key),
      digest: toBase64(a.digest),
      size: a.size,
      mime,
      name: safeName(a.name),
      ...safeSize(a.width, a.height),
      thumbnail: thumbnail.length > 0 && thumbnail.length <= MAX_RECEIVED_THUMB_BYTES ? toBase64(thumbnail) : undefined,
      durationMs: safeDuration(a.durationMs),
      voiceNote: a.voiceNote && mime.startsWith('audio/') ? true : undefined,
    }
  }

  private async appendMessage(conversationId: string, message: StoredMessage) {
    const list = await this.stored(conversationId)
    list.push(message)
    await this.store.putJson(`messages:${conversationId}`, list)
    const conv = this.state.conversations[conversationId]
    if (conv && message.kind !== 'notice') {
      conv.lastText = message.live
        ? 'Live location'
        : message.location
          ? 'Location'
        : message.file
        ? [attachmentLabel(message.file.mime, message.file.name, message.file.voiceNote), message.text].filter(Boolean).join(': ')
        : message.text
      conv.lastAt = Math.max(conv.lastAt, message.sentAt)
    }
    this.emit({ type: 'messages', conversationId })
    this.emitView()
  }

  private async setStatus(conversationId: string, messageId: string, status: ChatMessage['status'], error?: string) {
    const list = await this.stored(conversationId)
    const message = list.find((m) => m.id === messageId)
    // A receipt may already have moved it past 'sent'.
    if (!message || (status === 'sent' && message.status !== 'sending')) return
    message.status = status
    message.error = error
    await this.store.putJson(`messages:${conversationId}`, list)
    this.emit({ type: 'messages', conversationId })
  }

  private async persist() {
    this.backupDirty = true
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

/** A call signal from a message, if well formed. */
function parseCall(view: CallView): CallSignal | undefined {
  const kind = CALL_KINDS[view.kind]
  if (!kind || view.callId.length !== 16) return undefined
  const signal: CallSignal = { callId: toHex(view.callId), kind }
  if (kind === 'offer' || kind === 'answer') {
    signal.sdp = safeSignalText(view.sdp, 64 * 1024)
    if (!signal.sdp) return undefined
  }
  if (kind === 'candidate') {
    signal.candidate = safeSignalText(view.candidate, 4 * 1024)
    if (!signal.candidate) return undefined
  }
  if (kind === 'offer') signal.video = view.video
  if (view.toDevice.length === 16) signal.toDevice = toHex(view.toDevice)
  return signal
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : String(e)
}

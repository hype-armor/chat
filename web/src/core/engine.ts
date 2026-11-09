// The client engine. Runs in the core worker and owns the device keys,
// encrypted storage, REST calls and the WebSocket. The UI thread only
// receives `AppView` snapshots and message lists.

import { markMeSyncDirty, meBindingKey, meDeletionBindings, meDeletionChunks, mergeMeDeletions, parseMeDeletions, validMeBinding, type MeDeletionBinding } from './me-deletion-sync'
import { DELETE_WINDOW_MS, addCandidate, emptyDeletions, equivalent, mergeDeletions, newRequestTime, promoteCandidates, safeTime, suppresses, timely, validBinding, type DeletionBinding, type DeletionLedger, type DeletionRecord, type DeletionOriginal } from './deletions'
import { bindingMatches, validReaction, reactionStates, reactionChips, type ReactionUpdate } from './reactions'

import init, {
  AttachmentView,
  CallMedia,
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
import { isAvatar, prepareAvatar } from './avatar'
import {
  type CommitOutcome,
  MAX_SEND_RETRIES,
  RATE_LIMITED,
  commitWasAccepted,
  retryDelay,
  sendOutcome,
  throwUnlessAccepted,
} from './commits'
import {
  RecentIds,
  fromHex,
  makeIdentity,
  plain,
  randomId,
  splitIdentity,
  toHex,
  trySplitIdentity,
} from './ids'
import {
  type DeviceSync,
  avatarSyncChunks,
  deviceHex,
  linkText,
  memberDevicePlan,
  parseDeviceSync,
  parseLinkCode,
} from './devices'
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
  DeleteAccepted,
  DeletionScope,
  Draft,
  DraftSave,
  TextSent,
  CallSignal,
  ChatMessage,
  IceServer,
  ConnectionState,
  CoreEvent,
  FileInfo,
  DeviceInfo,
  StorageUsage,
  InviteOffer,
  LinkOffer,
  LocationInfo,
  MediaSettings,
  MemberInfo,
  SafetyNumber,
} from './protocol'
import { type MediaInfo, isPhoto, isPlayable } from './protocol'
import { parseStorageUsage } from './storageUsage'
import { isMp4, scrubMp4 } from './mp4'
import { DEFAULT_MEDIA, autoDownloads, onMobileData } from './policy'
import * as transfers from './transfers'
import { prepareArea, safeLocation } from './maps'
import {
  LIVE_DURATIONS_MS,
  MAX_LIVE_DURATION_MS,
  canResumeUntilStopped,
  expiryForUpdate,
  plausibleExpiry,
  updateDue,
} from './live'
import { type MediaTransformOptions, frameTransform } from './media'
import { CALL_KINDS, type CallEnd, type CallRecord, GIVE_UP_MS, STALE_OFFER_MS, callNotice, isMissedCallNotice, safeSignalText } from './calls'
import { acceptsGroupInfo, designatedCommitter, isGroupView, parseAdmins } from './roles'
import { SecureStore } from './storage'
import { TypingClock, TypingLeases, TYPING_REFRESH_MS, TYPING_TTL_MS } from './typing'
import { buildReplyLookup, hashHex, replyPreview, validContentHash, validReplyId } from './replies'

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

/** Ordered MLS membership bound to the conversation object before a directory query. */
type SyncRoster = { conversation: Conversation; members: string[] }

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
type StoredMessage = Omit<ChatMessage, 'file' | 'reply' | 'reactions' | 'canReact' | 'reactionStatus'> & {
  hidden?: boolean
  reactionEvent?: ReactionUpdate
  file?: StoredFile
  /** Hashes bind previews to authenticated MLS content, not mutable outer IDs. */
  contentHash?: string
  replyToHash?: string
}

type Account = {
  username: string
  displayName: string
  /** This account's profile picture, base64 JPEG (avatar.ts). */
  avatar?: string
  accountId: string
  deviceId: string
  token: string
}

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
type Invitee = {
  username: string
  account: string
  devices: string[]
  /** One 32-byte `account ‖ device` identity per key package (audit H1). */
  identities: Uint8Array[]
  keyPackages: Uint8Array[]
}

/** A live-location session this device sends. */
type LiveSession = {
  sessionId: string
  conversationId: string
  /** The message that started it, which shows the session. */
  messageId: string
  expiresAt: number
  /** No fixed duration; remote copies use `expiresAt` as a renewable lease. */
  untilStopped?: boolean
  lastSentAt: number
  /** Immutable Native original evidence, not the timestamp/hash of a renewal. */
  binding?: { hash: string; author: string; at: number }
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
  /** Private own-device deletion-sync batch, never exposed to the UI. */
  meDeletionBatch?: string
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
  /** Account id (hex) → base64 profile picture from their profile message. */
  avatars: Record<string, string>
  /** Account id (hex) → username number, for contacts this user looked up. */
  usernames: Record<string, string>
  outbox: Outgoing[]
  meDeletionBatches?: Record<string, { revision: number; failed: boolean }>
  pendingMeDeletions?: { conversationId: string; device: string; bindings: MeDeletionBinding[] }[]
  /** Device-local revision fences. Never include in backup or device sync. */
  draftClears: Record<string, number>
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
  typingIndicators?: boolean
  /** Calls only through the TURN relay, hiding this device's IP address (FR-CALL-9). */
  relayCalls?: boolean
  /** Opt-in call statistics (ADR-0032): today's tallies, sent once a day. */
  callStats?: { since: number; direct: CallTally; group: CallTally }
  /** Encrypted backups (ADR-0022): on, and when the last one was uploaded. */
  backup?: { lastAt?: number }
  /** Auto-download and photo quality (ADR-0025). */
  media: MediaSettings
  /** Live-location sessions this device is sending (FR-LOC-2). */
  live: LiveSession[]
  /** Others' sessions shown here, to forget their points when they end. */
  liveSeen: { conversationId: string; messageId: string; expiresAt: number }[]
  /** The latest group call started in each group (ADR-0031), to offer "join". */
  groupCalls?: Record<string, { callId: string; video: boolean; startedAt: number }>
  /** Attachment uploads and downloads to resume after a reload or reconnect. */
  transfers: { conversationId: string; messageId: string; kind: 'upload' | 'download' }[]
}

type CallTally = { connected: number; failed: number; setup_seconds: number[] }
const emptyTally = (): CallTally => ({ connected: 0, failed: 0, setup_seconds: [] })
const STATS_EVERY_MS = 24 * 3600_000

/** What a backup holds (ADR-0022): no MLS state, keys or tokens. */
type BackupPayload = {
  version: 1
  deletions?: DeletionLedger
  createdAt: number
  displayName: string
  avatar?: string
  state: Pick<
    State,
    'conversations' | 'names' | 'avatars' | 'usernames' | 'blocked' | 'verified' | 'keys' | 'readReceipts'
  >
  messages: Record<string, StoredMessage[]>
}

const emptyState = (): State => ({
  conversations: {},
  names: {},
  avatars: {},
  usernames: {},
  outbox: [],
  draftClears: {},
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
  /** SFrame keys of calls with media flowing, by call id (ADR-0030). */
  private media = new Map<string, { conversationId: string; media: CallMedia; createdAt: number }>()
  /**
   * Call ids whose SFrame keys this page has dropped. A new key state under a
   * used call id would start its frame counter at 0 and repeat nonces, so such
   * a call cannot be joined again here (audit M10).
   */
  private readonly endedCalls = new Set<string>()
  /**
   * `DeviceSync` frames from an own device this page did not know yet (a
   * device linked or restored a moment ago). Applied once the server's device
   * list confirms it (audit H1).
   */
  private pendingSyncs: { conversationId: string; device: string; bytes: Uint8Array; accountId: string; epoch: number }[] = []
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
  private typingLeases = new Map<string, TypingLeases>()
  private typingSent = new Map<string, { active: boolean; at: number }>()
  private typingTimer?: ReturnType<typeof setInterval>
  private typingPublished = new Map<string, string>()
  private typingConversation?: string
  /** These floors survive empty lease maps and reconnects, until sign-out. */
  private typingClock = new TypingClock()
  private typingSentAt = 0

  /** Serialises every mutation of core state and storage. */
  private lock: Promise<unknown> = Promise.resolve()
  private deletionCache?: { accountId: string; epoch: number; ledger: DeletionLedger }
  private deletionLock: Promise<unknown> = Promise.resolve()
  private deletionClock = new TypingClock()
  private starting = false
  private deletionGeneration = 0
  private deletionPreviewsReady = new Set<string>()
  private acceptingDeletions = new Set<string>()
  private acceptingMeDeletionSync = new Set<string>()
  private meDeletionSyncTimer?: ReturnType<typeof setTimeout>
  private hiddenSendCleanupTimer?: ReturnType<typeof setTimeout>
  /** Only a fresh directory response can authorize replay of an unapplied incoming journal. */
  private meDirectorySession?: { accountId: string; epoch: number; core: CoreClient }
  private deletionKnown = new Map<string, DeletionOriginal[]>()
  private draftEpoch = 0
  private endingSession = false
  private draftChanges = new Map<string, Draft>()
  /** A concurrent flush must not transmit a text action before local acceptance. */
  private acceptingText = new Set<string>()
  private acceptingReactions = new Set<string>()

  constructor(private readonly emit: (event: CoreEvent) => void) {}

  async start() {
    this.starting = true
    // Back on the network: reconnect now rather than after the back-off.
    self.addEventListener('online', () => {
      if (this.starting || this.ws || !this.account) return
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
      await this.loadMeDeletionInbox()
      let deletions = await this.readDeletions()
      if (meDeletionBindings(deletions).length && deletions.meSyncRevision === undefined) deletions = await this.changeDeletions((ledger) => { markMeSyncDirty(ledger); return true })
      await this.reconcileLiveProducers()
      for (const conversationId of new Set(deletions.records.map((t) => t.conversation))) {
        this.emitDeletionBarrier(conversationId, deletions)
        await this.cleanupDeletion(conversationId).catch(() => undefined)
      }
      if (this.state.live.length > 0 || this.state.liveSeen.length > 0) this.scheduleLiveSweep()
      await this.reconcileHiddenSends().catch(() => this.scheduleHiddenSendCleanup())
      this.starting = false
      this.connect()
    }
    this.starting = false
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
        isGroup: isGroupView(c),
        amAdmin: (c.admins ?? []).includes(this.myAccount()),
        status: c.status ?? ('active' as const),
        memberCount: c.peers.length + 1,
        peer: !isGroupView(c) && c.peers.length === 1 ? c.peers[0] : undefined,
        blocked: !isGroupView(c) && c.peers.length === 1 && this.state.blocked.includes(c.peers[0]),
        request: c.request ?? false,
        unread: c.unread ?? 0,
        verification: !isGroupView(c) && c.peers.length === 1 ? this.verificationOf(c.peers[0]) : undefined,
        lastText: this.deletionCache?.accountId === this.account!.accountId && (!this.deletionCache.ledger.records.some((t) => t.conversation === c.id) || this.deletionPreviewsReady.has(c.id)) ? c.lastText : undefined,
        lastAt: c.lastAt,
      }))
    return {
      phase: 'ready',
      me: {
        account: this.myAccount(),
        username: this.account.username,
        displayName: this.account.displayName || this.account.username,
      },
      connection: this.connection,
      conversations,
      alerts: this.state.alerts,
      readReceipts: this.state.readReceipts,
      typingIndicators: this.state.typingIndicators !== false,
      relayCalls: this.state.relayCalls ?? false,
      callStats: !!this.state.callStats,
      backup: this.state.backup ? { lastAt: this.state.backup.lastAt } : undefined,
      media: this.state.media,
      liveSharing: this.state.live
        .filter((l) => this.liveProducerAllowed(l) && (l.untilStopped === true || l.expiresAt > Date.now()))
        .map((l) => ({
          conversationId: l.conversationId,
          title: this.state.conversations[l.conversationId] ? this.title(this.state.conversations[l.conversationId]) : '',
          expiresAt: l.expiresAt,
          untilStopped: l.untilStopped === true,
        })),
    }
  }

  // ---- profile pictures ----------------------------------------------------

  /**
   * Sets this account's profile picture from a photo, or removes it when
   * `file` is undefined. Everyone in a conversation gets it with their next
   * profile message, and this account's other devices get it in a sync.
   */
  async setAvatar(file?: Blob) {
    this.ready()
    const bytes = file ? await prepareAvatar(file) : undefined
    await this.exclusive(async () => {
      if (this.state.pendingCommit) throw new Error('Still finishing an earlier group change; try again shortly')
      this.account!.avatar = bytes ? toBase64(bytes) : undefined
      await this.store.putJson('account', this.account)
      for (const c of Object.values(this.state.conversations)) {
        if (!c.self && !c.status) this.queueProfile(c.id)
      }
      const self = Object.values(this.state.conversations).find((c) => c.self && !c.status)
      if (self) await this.queueDeviceSync(self.id)
      await this.persist()
    })
    this.emit({ type: 'avatar', account: this.myAccount() })
    this.emitView()
    void this.flushOutbox()
  }

  /** An account's profile picture as base64 JPEG, if it has one. */
  avatarOf(account: string): string | undefined {
    return account === this.myAccount() ? this.account?.avatar : this.state.avatars[account]
  }

  /** Keeps a contact's picture from their profile message; a missing or bad one removes it. */
  private setPeerAvatar(account: string, bytes: Uint8Array | undefined) {
    const next = bytes && isAvatar(bytes) ? toBase64(bytes) : undefined
    if (next === this.state.avatars[account]) return
    if (next) this.state.avatars[account] = next
    else delete this.state.avatars[account]
    this.emit({ type: 'avatar', account })
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
      this.draftEpoch++
      this.deletionCache = undefined
      this.deletionPreviewsReady.clear()
      this.deletionKnown.clear()
      this.pendingSyncs = []
      this.deletionClock = new TypingClock()
      this.endingSession = false
      this.draftChanges.clear()
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
    const session = this.deletionSession()
    const generation = this.deletionGeneration
    const { account } = this.ready()
    const key = await this.store.getKey('backup')
    this.assertDeletionSession(session)
    if (!key || !this.state.backup) return
    const payload = await this.exclusive(async () => {
      this.assertDeletionSession(session)
      const messages: Record<string, StoredMessage[]> = {}
      const conversations: State['conversations'] = {}
      for (const c of Object.values(this.state.conversations)) {
        if (c.self) continue
        conversations[c.id] = c
        messages[c.id] = await this.stored(c.id)
      }
      const { names, avatars, usernames, blocked, verified, keys, readReceipts } = this.state
      return {
        version: 1,
        deletions: structuredClone(await this.readDeletions()),
        createdAt: Date.now(),
        displayName: account.displayName,
        avatar: account.avatar,
        state: { conversations, names, avatars, usernames, blocked, verified, keys, readReceipts },
        messages,
      } satisfies BackupPayload
    })
    const sealed = await sealBackup(key, payload)
    this.assertDeletionSession(session)
    if (generation !== this.deletionGeneration) return
    await api.uploadBackup(account.token, sealed)
    this.assertDeletionSession(session)
    if (generation !== this.deletionGeneration) return
    await this.exclusive(async () => {
      this.assertDeletionSession(session)
      if (this.state.backup) this.state.backup.lastAt = payload.createdAt
      await this.persist()
    })
    this.backupDirty = generation !== this.deletionGeneration
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
      this.account!.avatar = backup.avatar
      await this.store.putJson('account', this.account)
      await this.changeDeletions((ledger) => {
        const previousMe = new Set(meDeletionBindings(ledger).map((b) => b.conversation + b.hash + b.author))
        const merged = mergeDeletions(ledger, backup.deletions ?? emptyDeletions())
        if (meDeletionBindings(merged).some((b) => !previousMe.has(b.conversation + b.hash + b.author))) markMeSyncDirty(ledger)
        ledger.records = merged.records
        ledger.candidates = merged.candidates
        return true
      })
      const restored = backup.state
      for (const c of Object.values(restored.conversations)) {
        c.status = c.status ?? 'restoring'
        c.request = undefined
        await this.store.putJson(`messages:${c.id}`, this.redactedHistory(c.id, backup.messages[c.id] ?? [], await this.readDeletions()))
      }
      // This device is the account's own: its key must not raise an alert.
      Object.assign(this.state, restored, {
        draftClears: {},
        backup: { lastAt: backup.createdAt },
        expectedOwn: [deviceHex(reg.device_id)],
      })
      for (const conversationId of new Set((await this.readDeletions()).records.map((t) => t.conversation))) await this.cleanupDeletion(conversationId).catch(() => undefined)
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

  async storageUsage(): Promise<StorageUsage> {
    const usage = await api.storageUsage(this.ready().account.token)
    return parseStorageUsage(usage)
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
    // Invalidate queued RPCs and transport now, then clear after an in-flight write ends.
    this.endingSession = true
    this.draftEpoch++
    clearTimeout(this.meDeletionSyncTimer)
    this.meDeletionSyncTimer = undefined
    clearTimeout(this.hiddenSendCleanupTimer)
    this.hiddenSendCleanupTimer = undefined
    this.meDirectorySession = undefined
    clearTimeout(this.retryTimer)
    clearTimeout(this.reconnectTimer)
    const ws = this.ws
    this.ws = undefined
    // Resolve requests now, including a flush that holds the mutation lock.
    for (const resolve of this.waiters.values()) resolve(undefined)
    this.waiters.clear()
    ws?.close()
    await this.exclusive(async () => {
      await this.deletionLock
      this.deletionCache = undefined
      this.deletionPreviewsReady.clear()
      this.deletionKnown.clear()
      this.pendingSyncs = []
      this.acceptingMeDeletionSync.clear()
      this.deletionClock = new TypingClock()
      this.account = undefined
      this.core = undefined
      this.state = emptyState()
      this.draftChanges.clear()
      this.notice = notice
      await this.store.clear()
      this.setConnection('offline')
      this.typingClock = new TypingClock()
      this.typingSentAt = 0
    })
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
    if (!this.account || this.connection !== 'online' || this.endingSession) return
    const { account, core } = this.ready()
    const session = this.draftSession()
    const current = () => !this.endingSession && this.connection === 'online' && this.core === core &&
      session.epoch === this.draftEpoch && session.accountId === this.account?.accountId
    try {
      // Capture before the FIRST directory await, including our own device query.
      // MLS leaf order also selects the authorized reconciliation actor.
      const rosters = await this.exclusive(async () => current() ? new Map(Object.values(this.state.conversations)
        .filter((c) => !c.status)
        .map((c) => [c.id, { conversation: c, members: (core.members(fromHex(c.id)) as Uint8Array[]).map(toHex) }])) : undefined)
      if (!rosters || !current()) return
      const { devices } = await api.devices(account.token)
      if (!current()) return
      const mine = devices.map((d) => deviceHex(d.device_id))
      this.state.myDevices = mine
      this.meDirectorySession = { accountId: session.accountId, epoch: session.epoch, core }
      // Syncs that waited for this list (a device linked a moment ago).
      const ready = this.pendingSyncs.filter((p) => mine.includes(p.device))
      this.pendingSyncs = this.pendingSyncs.filter((p) => !mine.includes(p.device))
      for (const pending of ready) {
        await this.exclusive(async () => {
          if (current() && pending.accountId === session.accountId && pending.epoch === session.epoch) await this.applyDeviceSync(pending.conversationId, pending.bytes, pending.device)
        })
        if (!current()) return
      }
      const thisDevice = deviceHex(account.deviceId)
      const hasSelf = Object.values(this.state.conversations).some((c) => c.self && !c.status)
      // The oldest device creates it; duplicates from races are tolerated.
      if (!hasSelf && mine.length > 1 && mine[0] === thisDevice) await this.createSelfConversation(mine, current)
      if (!current()) return
      const directory = await this.liveDevices(mine, rosters, account, current)
      if (!directory || !current()) return
      for (const [id, expected] of rosters) {
        if (!current()) return
        try {
          await this.reconcileDevices(id, directory.live, directory.queried, expected, current)
        } catch (e) {
          console.warn('updating devices in a conversation failed', e)
        }
      }
      await this.exclusive(async () => {
        if (!current()) return
        // New conversations were not queried. Never apply an old response to them.
        if (Object.values(this.state.conversations).some((c) => !c.status &&
          (!rosters.has(c.id) || !this.syncRosterMatches(c.id, rosters.get(c.id)!)))) this.scheduleSync()
      })
    } catch (e) {
      console.warn('device sync failed', e)
    }
    if (current()) { await this.flushMeDeletionSync(); this.emitView() }
  }

  private syncRosterMatches(conversationId: string, expected: SyncRoster): boolean {
    const conv = this.conv(conversationId)
    if (conv !== expected.conversation || conv.status) return false
    const members = (this.core!.members(fromHex(conversationId)) as Uint8Array[]).map(toHex)
    return members.length === expected.members.length && members.every((member, i) => member === expected.members[i])
  }

  /**
   * Every member account's current devices (hex), from the server; accounts
   * it doesn't return no longer exist (ADR-0022).
   */
  private async liveDevices(mine: string[], rosters: Map<string, SyncRoster>, account: Account, current: () => boolean) {
    const me = deviceHex(account.accountId)
    const others = new Set<string>()
    for (const roster of rosters.values()) {
      for (const member of roster.members) {
        const owner = splitIdentity(fromHex(member)).account
        if (owner !== me) others.add(owner)
      }
    }
    const live: Record<string, string[]> = { [me]: mine }
    const queried = new Set([me])
    const accounts = [...others]
    for (let i = 0; i < accounts.length; i += 200) {
      if (!current()) return undefined
      const chunk = accounts.slice(i, i + 200)
      const { devices } = await api.devicesOf(account.token, chunk)
      if (!current()) return undefined
      // An omitted account means deleted ONLY if this request queried it.
      for (const owner of chunk) queried.add(owner)
      for (const [owner, ids] of Object.entries(devices)) {
        const normalized = deviceHex(owner)
        if (chunk.includes(normalized)) live[normalized] = ids.map(deviceHex)
      }
    }
    return { live, queried }
  }

  /**
   * Brings a group's members' devices in line with `live` (ADR-0022), one
   * commit at a time: additions first, so a restored account still has a
   * leaf when its lost devices are removed.
   */
  private async reconcileDevices(conversationId: string, live: Record<string, string[]>, queried: Set<string>, expected: SyncRoster, current: () => boolean) {
    if (!current()) return
    const { account, core } = this.ready()
    const fresh = () => {
      if (!current()) return false
      if (!this.syncRosterMatches(conversationId, expected) || expected.members.some((member) => !queried.has(splitIdentity(fromHex(member)).account))) {
        this.scheduleSync()
        return false
      }
      return true
    }
    const accepted = (outcome: CommitOutcome) => {
      // Only our known accepted mutation can refresh this directory snapshot.
      // Arbitrary commits during directory, claim, or flush awaits must not do so.
      if (outcome === 'accepted' && current()) expected.members = (core.members(fromHex(conversationId)) as Uint8Array[]).map(toHex)
      return outcome
    }
    for (let round = 0; round < 4; round++) {
      const conv = this.state.conversations[conversationId]
      if (!conv || conv.status || this.state.pendingCommit || !fresh()) return
      const members = expected.members.map((member) => {
        const { account, device } = splitIdentity(fromHex(member))
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
          if (this.state.pendingCommit || !fresh()) return undefined
          await this.flushOutbox(true)
          if (this.state.pendingCommit || !fresh()) return undefined
          const existing = this.recipients(conversationId)
          const added = core.addMembers(
            fromHex(conversationId),
            invitee.identities,
            invitee.keyPackages,
            randomId(),
            randomId(),
          )
          const pending: PendingCommit = {
            conversationId,
            commitHash: toBase64(added.commitHash),
            invitees: [{ account: invitee.account, username: invitee.username, devices: invitee.devices }],
          }
          const welcome = { envelope: added.welcome, recipients: invitee.devices }
          const after = [...new Set([...this.memberDevices(conversationId), ...invitee.devices])]
          return accepted(await this.sendCommit(pending, added.commit, existing, welcome, after))
        })
      } else if (removing.length > 0) {
        outcome = await this.exclusive(async () => {
          if (this.state.pendingCommit || !fresh()) return undefined
          await this.flushOutbox(true)
          if (this.state.pendingCommit || !fresh()) return undefined
          const everyone = this.recipients(conversationId)
          const identities = removing.flatMap((p) => p.stale.map((d) => fromHex(p.account + d)))
          const staged = core.removeMembers(fromHex(conversationId), identities, randomId())
          const pending: PendingCommit = { conversationId, commitHash: toBase64(staged.commitHash) }
          const gone = removing.flatMap((p) => p.stale)
          const after = this.memberDevices(conversationId).filter((d) => !gone.includes(d))
          return accepted(await this.sendCommit(pending, staged.commit, everyone, undefined, after))
        })
      }
      if (outcome !== 'accepted') return
    }
    // More than 4 changes need a fresh directory snapshot, not a 10-minute wait.
    if (current()) this.scheduleSync()
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
    const identities = found.map((d) => makeIdentity(account, d))
    const keyPackages = found.map((d) => fromBase64(packages.get(d)!))
    this.checkIdentities(identities, keyPackages)
    return {
      username: account === this.myAccount() ? me.username : (this.state.usernames[account] ?? ''),
      account,
      devices: found,
      identities,
      keyPackages,
    }
  }

  /**
   * Refuses any claimed key package whose credential identity is not the
   * account and device it was claimed for (audit H1). The key directory hands
   * out packages that their uploader chose, so a package can claim to belong
   * to someone else. Without this check, messages from that member would be
   * shown as the other account's.
   */
  private checkIdentities(identities: Uint8Array[], keyPackages: Uint8Array[]) {
    const { core } = this.ready()
    identities.forEach((identity, i) => {
      const claimed = core.keyPackageIdentity(keyPackages[i])
      if (toHex(claimed) !== toHex(identity)) {
        throw new Error('the server sent a key that belongs to another account')
      }
    })
  }

  /** This account's other devices, for new conversations. */
  private async otherOwnDevices(): Promise<Invitee | undefined> {
    const thisDevice = deviceHex(this.ready().account.deviceId)
    return this.ownInvitee(this.state.myDevices.filter((d) => d !== thisDevice))
  }

  private async createSelfConversation(mine: string[], current: () => boolean) {
    if (!current()) return
    const thisDevice = deviceHex(this.ready().account.deviceId)
    const invitee = await this.ownInvitee(mine.filter((d) => d !== thisDevice))
    if (!invitee) return
    await this.exclusive(async () => {
      if (!current()) return
      const started = this.core!.startConversation(invitee.identities, invitee.keyPackages, randomId())
      const id = toHex(started.conversationId)
      this.state.conversations[id] = { id, peers: [], self: true, lastAt: Date.now() }
      await this.observeKeysIn(id)
      this.state.outbox.push({
        messageId: toHex(randomId()),
        conversationId: id,
        envelope: toBase64(started.welcome),
        recipients: invitee.devices,
      })
      await this.queueDeviceSync(id)
      await this.persist()
    })
    void this.flushOutbox()
  }

  /** Shares names and group metadata with this account's other devices. */
  private async queueDeviceSync(selfId: string) {
    const sync: DeviceSync = {
      displayName: this.account!.displayName,
      avatar: this.account!.avatar ?? null,
      names: this.state.names,
      usernames: this.state.usernames,
      blocked: this.state.blocked,
      conversations: Object.fromEntries(
        Object.values(this.state.conversations)
          .filter((c) => !c.self && !c.status && !c.request)
          .map((c) => [c.id, { name: c.name, admins: c.admins }]),
      ),
    }
    const queue = (state: DeviceSync) => {
      const messageId = randomId()
      const envelope = this.core!.sendDeviceSync(
        fromHex(selfId),
        new TextEncoder().encode(JSON.stringify(state)),
        Date.now(),
        messageId,
      )
      this.acceptingMeDeletionSync.add(toHex(messageId))
      this.state.outbox.push({
        messageId: toHex(messageId),
        conversationId: selfId,
        envelope: toBase64(envelope),
        recipients: this.recipients(selfId),
      })
    }
    queue(sync)
    for (const avatars of avatarSyncChunks(this.state.avatars)) {
      queue({ names: {}, usernames: {}, conversations: {}, avatars })
    }
    await this.queueMeDeletionSync(selfId, true)
  }

  /** Applies a `DeviceSync` from another of this account's devices. */
  private async applyDeviceSync(conversationId: string, bytes: Uint8Array, senderDevice?: string) {
    if (senderDevice && !this.privateSelfContext(conversationId, senderDevice)) return
    if (senderDevice) await this.applyMeDeletionSync(conversationId, bytes, senderDevice)
    const sync = parseDeviceSync(bytes)
    const conv = this.conv(conversationId)
    if (!sync || !conv) return
    conv.self = true
    conv.peers = []
    if (sync.displayName && this.account) {
      this.account.displayName = sync.displayName
      await this.store.putJson('account', this.account)
    }
    // Older linked devices omitted `avatar`; only null explicitly removes it.
    if (this.account && sync.avatar !== undefined && (sync.avatar ?? undefined) !== this.account.avatar) {
      this.account.avatar = sync.avatar ?? undefined
      await this.store.putJson('account', this.account)
      this.emit({ type: 'avatar', account: this.myAccount() })
    }
    for (const [account, avatar] of Object.entries(sync.avatars ?? {})) {
      if (avatar !== this.state.avatars[account]) {
        this.state.avatars[account] = avatar
        this.emit({ type: 'avatar', account })
      }
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
  private async replenishKeyPackages(known?: number, currentSocket: () => boolean = () => true) {
    if (this.replenishing || !this.account || this.endingSession || !currentSocket()) return
    const session = this.draftSession()
    const current = () => currentSocket() && !this.endingSession &&
      session.epoch === this.draftEpoch && session.accountId === this.account?.accountId
    this.replenishing = true
    try {
      const token = this.account.token
      const available = known ?? (await api.keyCount(token)).available
      const count = keyPackagesToUpload(available)
      if (count === 0 || !current()) return
      const packages = await this.exclusive(async () => {
        if (!current()) return []
        const fresh = this.core!.keyPackages(count) as Uint8Array[]
        // Their private keys must be stored before anyone can use them.
        await this.persist()
        return fresh
      })
      if (current() && packages.length > 0) await api.uploadKeyPackages(token, packages.map(toBase64))
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
      const conv = this.conv(conversationId)
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

  /** Turns opt-in call statistics on or off (ADR-0032); off forgets what was counted. */
  async setCallStats(on: boolean) {
    await this.exclusive(async () => {
      this.state.callStats = on ? { since: Date.now(), direct: emptyTally(), group: emptyTally() } : undefined
      await this.persist()
    })
    this.emitView()
  }

  /** Counts a call that got as far as connecting (only with statistics on). */
  async recordCall(kind: 'direct' | 'group', connected: boolean, setupMs?: number) {
    const stats = this.state.callStats
    if (!stats) return
    await this.exclusive(async () => {
      const tally = stats[kind]
      if (connected) tally.connected++
      else tally.failed++
      if (connected && setupMs !== undefined && tally.setup_seconds.length < 100) {
        tally.setup_seconds.push(Math.min(120, Math.max(0, Math.round(setupMs / 100) / 10)))
      }
      await this.persist()
    })
    void this.reportCallStats()
  }

  /** Sends yesterday's tallies, unauthenticated, at most once a day. */
  private async reportCallStats() {
    const stats = this.state.callStats
    if (!stats || Date.now() - stats.since < STATS_EVERY_MS || this.connection !== 'online') return
    const counted = (t: CallTally) => t.connected + t.failed > 0
    if (counted(stats.direct) || counted(stats.group)) {
      try {
        await api.callStats({ direct: stats.direct, group: stats.group })
      } catch (e) {
        console.warn('sending call statistics failed', e)
        return
      }
    }
    await this.exclusive(async () => {
      if (this.state.callStats) this.state.callStats = { since: Date.now(), direct: emptyTally(), group: emptyTally() }
      await this.persist()
    })
  }

  async setRelayCalls(on: boolean) {
    await this.exclusive(async () => {
      this.state.relayCalls = on
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
      if (self) await this.queueDeviceSync(self.id)
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
      const identities = [
        ...devices.map((d) => makeIdentity(peer, deviceHex(d))),
        ...(own?.identities ?? []),
      ]
      const keyPackages = [
        ...devices.map((d) => fromBase64(claimed.key_packages[d])),
        ...(own?.keyPackages ?? []),
      ]
      // The peer's packages are checked here; our own devices were checked
      // when they were claimed (audit H1).
      this.checkIdentities(identities.slice(0, devices.length), keyPackages.slice(0, devices.length))
      const started = core.startConversation(identities, keyPackages, randomId())
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
        everyone.flatMap((i) => i.identities),
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
    const conv = this.conv(conversationId)
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
        invitees.flatMap((i) => i.identities),
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
      const after = [...new Set([...this.memberDevices(conversationId), ...invitees.flatMap((i) => i.devices)])]
      throwUnlessAccepted(
        await this.sendCommit(pending, added.commit, existing, welcome, after),
        'adding people',
      )
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
      const after = this.withoutAccounts(conversationId, [account])
      throwUnlessAccepted(
        await this.sendCommit(pending, staged.commit, everyone, undefined, after),
        'removing them',
      )
    })
    this.emitView()
    void this.flushOutbox()
  }

  /** Proposes our own removal; another member commits it (ADR-0016). */
  async leaveGroup(conversationId: string) {
    const { core } = this.ready()
    const conv = this.group(conversationId)
    if (conv.status) return
    await this.stopLive(conversationId)
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
      await this.invalidateDraft(conversationId)
      this.state.live = this.state.live.filter((l) => l.conversationId !== conversationId)
      await this.endGroupLiveLocations(conversationId)
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

  /** Identifiers invalidate cached UI content; they never authorize a network action. */
  private privateSelfContext(conversationId: string, senderDevice?: string, requireCurrentDevices = true): boolean {
    const conv = this.conv(conversationId)
    if (!conv || conv.status || this.endingSession || !this.core || !this.account) return false
    if (!conv.self && (conv.peers.length > 0 || conv.name || conv.admins?.length || conv.request)) return false
    try {
      const members = (this.core.members(fromHex(conversationId)) as Uint8Array[]).map(splitIdentity)
      const devices = new Set(this.state.myDevices)
      return members.length > 0 && members.every((m) => m.account === this.myAccount() && (!requireCurrentDevices || devices.has(toHex(m.device)))) &&
        members.some((m) => toHex(m.device) === deviceHex(this.account!.deviceId)) &&
        (senderDevice === undefined || (!requireCurrentDevices || devices.has(senderDevice)) && members.some((m) => toHex(m.device) === senderDevice))
    } catch { return false }
  }

  private rememberDeletionOriginals(conversationId: string, originals: DeletionOriginal[]) {
    const known = this.deletionKnown.get(conversationId) ?? []
    for (const m of originals) if (m.kind !== 'notice' && validContentHash(m.contentHash) && !known.some((k) => k.id === m.id && k.from === m.from && k.contentHash === m.contentHash)) {
      known.push({ id: m.id, from: m.from, contentHash: m.contentHash, sentAt: m.sentAt, live: m.live ? { sessionId: m.live.sessionId } : undefined })
    }
    this.deletionKnown.set(conversationId, known)
  }

  private async loadMeDeletionInbox() {
    const session = this.deletionSession()
    const saved = await this.store.getJson<NonNullable<State['pendingMeDeletions']>>('me-deletion-inbox:' + session.accountId)
    this.assertDeletionSession(session)
    if (!saved?.length) return
    const pending = this.state.pendingMeDeletions ??= []
    for (const item of saved) {
      const old = pending.find((p) => p.conversationId === item.conversationId && p.device === item.device)
      if (old) old.bindings = [...new Map([...old.bindings, ...item.bindings].map((b) => [meBindingKey(b), b])).values()]
      else pending.push(item)
    }
  }

  private meDeletionSyncAlert() {
    if (this.endingSession || !this.account) return
    const id = 'me-deletion-sync'
    if (!this.state.alerts.some((a) => a.id === id)) this.state.alerts.push({ id, text: 'Message deletion sync to your devices is unconfirmed. It will retry.' })
    this.emitView()
  }

  private scheduleMeDeletionSync() {
    if (this.meDeletionSyncTimer || this.endingSession || !this.account) return
    const session = this.deletionSession()
    this.meDeletionSyncTimer = setTimeout(() => {
      this.meDeletionSyncTimer = undefined
      try { this.assertDeletionSession(session) } catch { return }
      void this.flushMeDeletionSync()
    }, 5_000)
  }

  private async flushMeDeletionSync() {
    if (!this.account || this.endingSession || this.connection !== 'online') return
    const session = this.deletionSession()
    try {
      await this.exclusive(async () => {
        this.assertDeletionSession(session)
        const pending = [...(this.state.pendingMeDeletions ?? [])]
        for (const item of pending) {
          const confirmed = this.meDirectorySession
          if (!confirmed || confirmed.accountId !== session.accountId || confirmed.epoch !== session.epoch || confirmed.core !== session.core) continue
          if (!this.privateSelfContext(item.conversationId, item.device)) continue
          for (const bytes of meDeletionChunks(item.bindings)) await this.applyMeDeletionSync(item.conversationId, bytes, item.device)
        }
        const self = Object.values(this.state.conversations).find((c) => this.privateSelfContext(c.id))
        const queued = self ? await this.queueMeDeletionSync(self.id) : false
        const gated = this.state.outbox.some((o) => this.acceptingMeDeletionSync.has(o.messageId))
        const ledger = await this.readDeletions()
        const healthy = (ledger.meSyncRevision ?? 0) <= (ledger.meSyncAcknowledged ?? 0) && !this.state.pendingMeDeletions?.length
        const hadAlert = this.state.alerts.some((a) => a.id === 'me-deletion-sync')
        if (healthy) this.state.alerts = this.state.alerts.filter((a) => a.id !== 'me-deletion-sync')
        if (queued || gated || pending.length || healthy && hadAlert) await this.persist()
      })
      this.assertDeletionSession(session)
      void this.flushOutbox()
    } catch {
      try { this.assertDeletionSession(session) } catch { return }
      this.meDeletionSyncAlert(); this.scheduleMeDeletionSync()
    }
  }

  /** The caller holds the mutation lock. Each batch contains the complete verified Me union. */
  private async queueMeDeletionSync(selfId: string, bootstrap = false): Promise<boolean> {
    const session = this.deletionSession()
    if (!this.privateSelfContext(selfId)) return false
    let ledger = await this.readDeletions()
    this.assertDeletionSession(session)
    const bindings = meDeletionBindings(ledger)
    if (!bindings.length) return false
    if (bootstrap || ledger.meSyncRevision === undefined) ledger = await this.changeDeletions((next) => { markMeSyncDirty(next); return true })
    this.assertDeletionSession(session)
    const revision = ledger.meSyncRevision ?? 0
    if (revision <= (ledger.meSyncAcknowledged ?? 0)) return false
    const batches = this.state.meDeletionBatches ??= {}
    for (const [id, batch] of Object.entries(batches)) {
      if (!this.state.outbox.some((o) => o.meDeletionBatch === id)) delete batches[id]
      else if (batch.revision >= revision) return false
    }
    const batchId = toHex(randomId())
    const queued: Outgoing[] = []
    try {
      for (const bytes of meDeletionChunks(bindings)) {
        const id = randomId()
        const envelope = session.core.sendDeviceSync(fromHex(selfId), bytes, Date.now(), id)
        queued.push({ messageId: toHex(id), conversationId: selfId, envelope: toBase64(envelope), recipients: this.recipients(selfId), meDeletionBatch: batchId })
      }
    } catch (error) {
      // No partial batch can acknowledge the full union. Preserve the advanced ratchet.
      this.scheduleMeDeletionSync()
      throw error
    }
    this.assertDeletionSession(session)
    batches[batchId] = { revision, failed: false }
    for (const item of queued) this.acceptingMeDeletionSync.add(item.messageId)
    this.state.outbox.push(...queued)
    return true
  }

  private async settleMeDeletionBatch(item: Outgoing, failed: boolean) {
    const id = item.meDeletionBatch
    const batch = id && this.state.meDeletionBatches?.[id]
    if (!id || !batch) return
    batch.failed ||= failed
    if (failed) this.meDeletionSyncAlert()
    if (this.state.outbox.some((o) => o.meDeletionBatch === id)) return
    try {
      if (!batch.failed) await this.changeDeletions((ledger) => {
        ledger.meSyncAcknowledged = Math.max(ledger.meSyncAcknowledged ?? 0, batch.revision)
        return true
      })
    } catch { this.scheduleMeDeletionSync() }
    finally { delete this.state.meDeletionBatches![id] }
    const ledger = await this.readDeletions()
    if ((ledger.meSyncRevision ?? 0) > (ledger.meSyncAcknowledged ?? 0) || this.state.pendingMeDeletions?.length) this.scheduleMeDeletionSync()
    else { this.state.alerts = this.state.alerts.filter((a) => a.id !== 'me-deletion-sync'); this.emitView() }
  }

  private stageMeDeletionInput(conversationId: string, device: string, bindings: MeDeletionBinding[]) {
    if (!bindings.length) return
    const pending = this.state.pendingMeDeletions ??= []
    const old = pending.find((p) => p.conversationId === conversationId && p.device === device)
    const union = new Map([...(old?.bindings ?? []), ...bindings].map((b) => [meBindingKey(b), b]))
    if (old) old.bindings = [...union.values()]
    else pending.push({ conversationId, device, bindings: [...union.values()] })
  }

  private async applyMeDeletionSync(conversationId: string, bytes: Uint8Array, senderDevice: string) {
    const session = this.deletionSession()
    if (!this.privateSelfContext(conversationId, senderDevice)) return
    const bindings = parseMeDeletions(bytes)
    if (!bindings.length) return
    let novel: MeDeletionBinding[] = []
    let ledger: DeletionLedger
    try {
      ledger = await this.changeDeletions((next) => {
        novel = mergeMeDeletions(next, bindings)
        if (!novel.length) return false
        for (const conversation of new Set(novel.map((b) => b.conversation))) {
          this.mergeDeletionEvidence(next, conversation, this.deletionKnown.get(conversation) ?? [])
        }
        return true
      })
    } catch {
      this.assertDeletionSession(session)
      // The normal app/ratchet commit retains authenticated, normalized input for retry.
      // Never acknowledge and forget a valid own-device union because ledger cleanup failed.
      this.stageMeDeletionInput(conversationId, senderDevice, bindings)
      this.meDeletionSyncAlert(); this.scheduleMeDeletionSync()
      return
    }
    this.assertDeletionSession(session)
    const accepted = new Set(meDeletionBindings(ledger).map(meBindingKey))
    this.state.pendingMeDeletions = this.state.pendingMeDeletions?.map((p) => ({ ...p, bindings: p.bindings.filter((b) => !accepted.has(meBindingKey(b))) })).filter((p) => p.bindings.length)
    if (!novel.length) return
    for (const conversation of new Set(novel.map((b) => b.conversation))) {
      for (const record of ledger.records.filter((t) => t.conversation === conversation && t.scope === 'me')) this.applyDeletionEffects(record)
      this.emitDeletionBarrier(conversation, ledger, this.deletionKnown.get(conversation) ?? [])
      await this.cleanupDeletion(conversation).catch(() => undefined)
    }
    this.scheduleMeDeletionSync()
    this.emitView()
  }

  private emitDeletionBarrier(conversationId: string, ledger: DeletionLedger, originals: DeletionOriginal[] = []) {
    const scopes = new Map<string, DeletionScope>()
    for (const record of ledger.records.filter((t) => t.conversation === conversationId)) {
      const aliases = new Set([record.target, ...(record.aliases ?? []), ...originals.filter((m) => suppresses(record, m, conversationId, this.myAccount())).map((m) => m.id)])
      for (const id of aliases) if (id && scopes.get(id) !== 'me') scopes.set(id, record.scope)
    }
    if (scopes.size) this.emit({ type: 'messages', conversationId, deletions: [...scopes].map(([messageId, scope]) => ({ messageId, scope })) })
  }

  private mergeDeletionEvidence(ledger: DeletionLedger, conversationId: string, originals: (DeletionOriginal & { file?: { size: number } })[]): boolean {
    let changed = promoteCandidates(ledger, conversationId, originals, this.myAccount())
    for (const record of ledger.records.filter((t) => t.conversation === conversationId)) {
      const aliases = new Set([record.target, ...(record.aliases ?? [])].filter(Boolean))
      for (const original of originals) if (suppresses(record, original, conversationId, this.myAccount())) {
        aliases.add(original.id)
        if (!record.target) { record.target = original.id; changed = true }
        if (original.live && !record.liveSession) { record.liveSession = original.live.sessionId; changed = true }
        if (original.file && record.fileParts === undefined) { record.fileParts = Math.ceil(sealedLength(original.file.size) / transfers.PIECE_BYTES); changed = true }
      }
      if (aliases.size !== record.aliases?.length) { record.aliases = [...aliases]; changed = true }
    }
    return changed
  }

  private refreshDeletionPreview(conversationId: string, list: StoredMessage[]) {
    const conv = this.conv(conversationId)
    if (!conv) return
    // History reads must preserve missed-call summaries, including pre-deletion records.
    // Other notices and reaction controls never become sidebar previews.
    const last = list.filter((m) => !m.hidden && !m.reactionEvent && (m.kind !== 'notice' || isMissedCallNotice(m.text))).reduce<StoredMessage | undefined>((latest, m) => !latest || m.sentAt >= latest.sentAt ? m : latest, undefined)
    conv.lastText = !last ? undefined : last.deleted ? 'Message deleted' : last.live ? 'Live location' : last.location ? 'Location' : last.file ? [attachmentLabel(last.file.mime, last.file.name, last.file.voiceNote), last.text].filter(Boolean).join(': ') : last.text
    this.deletionPreviewsReady.add(conversationId)
  }

  private deletionAllowed(conversationId: string): boolean {
    const conv = this.conv(conversationId)
    if (!conv || conv.status || this.state.pendingCommit?.conversationId === conversationId || !this.core || this.endingSession) return false
    try {
      return (this.core.members(fromHex(conversationId)) as Uint8Array[]).some((m) => toHex(m) === toHex(this.core!.identity()))
    } catch { return false } // An unavailable roster cannot grant deletion authority.
  }

  private deletionSession() {
    const session = { ...this.draftSession(), core: this.ready().core }
    this.assertDeletionSession(session)
    return session
  }

  private assertDeletionSession(session: { accountId: string; epoch: number; core: CoreClient }) {
    this.assertReactionSession(session)
    if (this.core !== session.core) throw new Error('The deletion session ended')
  }

  private async readDeletions(): Promise<DeletionLedger> {
    const session = this.deletionSession()
    if (this.deletionCache?.accountId === session.accountId && this.deletionCache.epoch === session.epoch) return this.deletionCache.ledger
    const ledger = (await this.store.getJson<DeletionLedger>('deletions:' + session.accountId)) ?? emptyDeletions()
    this.assertDeletionSession(session)
    if (this.deletionCache?.accountId !== session.accountId || this.deletionCache.epoch !== session.epoch) {
      this.deletionCache = { ...session, ledger }
    }
    return this.deletionCache.ledger
  }

  private changeDeletions(change: (ledger: DeletionLedger) => boolean): Promise<DeletionLedger> {
    const session = this.deletionSession()
    const run = this.deletionLock.then(async () => {
      this.assertDeletionSession(session)
      const ledger = structuredClone(await this.readDeletions())
      this.assertDeletionSession(session)
      if (change(ledger)) {
        // This atomic encrypted write is the irreversible local acceptance point.
        await this.store.putJson('deletions:' + session.accountId, ledger)
        this.assertDeletionSession(session)
        this.deletionCache = { ...session, ledger }
        this.backupDirty = true
        this.deletionGeneration++
      }
      return ledger
    })
    this.deletionLock = run.catch(() => undefined)
    return run
  }

  private redactedHistory(conversationId: string, list: StoredMessage[], ledger: DeletionLedger): StoredMessage[] {
    const records = ledger.records.filter((t) => t.conversation === conversationId)
    return list.filter((m) => !m.reactionEvent || !records.some((t) => t.hash
      ? t.hash === m.reactionEvent!.hash && t.author === m.reactionEvent!.author
      : t.target === m.reactionEvent!.target)).map((m) => {
      const matches = records.filter((t) => suppresses(t, m, conversationId, this.myAccount()))
      if (!matches.length) return m
      const hidden = matches.some((t) => t.scope === 'me')
      return { id: m.id, from: m.from, sentAt: m.sentAt, status: m.status,
        contentHash: m.contentHash, text: '', deleted: true, hidden }
    })
  }

  private deletionStatus(conversationId: string, m: StoredMessage, ledger: DeletionLedger): ChatMessage['deletionStatus'] {
    const records = ledger.records.filter((t) => t.scope === 'everyone' && suppresses(t, m, conversationId, this.myAccount()))
    if (records.some((t) => t.remote)) return undefined
    const intent = records.find((t) => t.localIntent && t.eventId && !t.acknowledged)
    if (!intent?.eventId) return undefined
    const status = this.state.outbox.some((o) => o.conversationId === conversationId && o.messageId === intent.eventId) ? 'sending' : 'failed'
    return { id: intent.eventId, status, error: status === 'failed' ? intent.error ?? 'Deletion delivery is unconfirmed. Retry the request.' : undefined }
  }

  async deleteMessage(conversationId: string, messageId: string, scope: DeletionScope): Promise<DeleteAccepted> {
    const session = this.deletionSession()
    if (scope !== 'me' && scope !== 'everyone') throw new Error('Invalid deletion scope')
    await this.exclusive(async () => {
      this.assertDeletionSession(session)
      const list = await this.stored(conversationId)
      this.assertDeletionSession(session)
      const target = list.find((m) => m.id === messageId && m.kind !== 'notice' && !m.reactionEvent)
      if (!target) throw new Error('The original message is unavailable')
      const ledger = await this.readDeletions()
      this.assertDeletionSession(session)
      const previous = ledger.records.find((t) => t.scope === scope && suppresses(t, target, conversationId, this.myAccount()))
      if (scope === 'everyone' && (!this.deletionAllowed(conversationId) || target.from !== 'me')) throw new Error('This message cannot be deleted for everyone')
      if (previous) return
      if (target.deleted && scope === 'everyone') throw new Error('The original message was deleted')
      const verified = validContentHash(target.contentHash)
      const syncable = validMeBinding({ conversation: conversationId, hash: target.contentHash, author: target.from === 'me' ? this.myAccount() : target.from })
      const requestAt = scope === 'everyone' ? newRequestTime(target.sentAt, this.deletionClock.now()) : undefined
      if (scope === 'everyone') {
        this.checkCanSend(conversationId)
        if (!this.deletionAllowed(conversationId) || target.from !== 'me' || !verified || requestAt === undefined) throw new Error('This message cannot be deleted for everyone')
      }
      // Keep only an already accepted Me upload's private transport source outside history/backup.
      if (scope === 'me' && target.status === 'sending' && target.file && this.state.transfers.some((t) => t.kind === 'upload' && t.messageId === target.id)) {
        const { file } = target
        const capsule = { sentAt: target.sentAt, text: target.text, replyTo: target.replyTo, replyToHash: target.replyToHash,
          file: { key: file.key, digest: file.digest, size: file.size, mime: file.mime, name: file.name, durationMs: file.durationMs, voiceNote: file.voiceNote, blobId: file.blobId, uploadId: file.uploadId } }
        await this.registerHiddenSend(conversationId, target.id)
        await this.store.putJson('hidden-send:' + conversationId + ':' + target.id, capsule)
        this.assertDeletionSession(session)
      }
      const record: DeletionRecord = { localIntent: scope === 'everyone', scope, conversation: conversationId, target: target.id,
        hash: verified ? target.contentHash : undefined,
        author: target.from === 'me' ? this.myAccount() : target.from,
        originalAt: verified ? target.sentAt : undefined, liveSession: target.live?.sessionId, fileParts: target.file ? Math.ceil(sealedLength(target.file.size) / transfers.PIECE_BYTES) : undefined,
        requestAt, eventId: scope === 'everyone' ? toHex(randomId()) : undefined,
        status: scope === 'everyone' ? 'failed' : undefined,
      }
      record.aliases = list.filter((m) => suppresses(record, m, conversationId, this.myAccount())).map((m) => m.id)
      try {
        await this.changeDeletions((next) => { next.records.push(record); if (scope === 'me' && syncable) markMeSyncDirty(next); return true })
      } catch (error) {
        if (scope === 'me') await this.removeHiddenSend(conversationId, target.id).catch(() => undefined)
        throw error
      }
      this.assertDeletionSession(session)
      // No cleanup error can turn an accepted tombstone into a rejected deletion.
      this.applyDeletionEffects(record)
      this.emitDeletionBarrier(conversationId, await this.readDeletions(), list)
      await this.cleanupDeletion(conversationId).catch(() => undefined)
      if (scope === 'everyone') await this.sendDeletionIntent(record, session)
      else {
        try {
          const self = Object.values(this.state.conversations).find((c) => this.privateSelfContext(c.id))
          if (self && syncable) await this.queueMeDeletionSync(self.id)
          await this.persist()
        } catch { this.meDeletionSyncAlert(); this.scheduleMeDeletionSync() }
      }
    })
    this.assertDeletionSession(session)
    this.emit({ type: 'messages', conversationId })
    this.emitView()
    void this.flushOutbox()
    return { accepted: true, scope }
  }

  async retryDeletion(conversationId: string, deletionEventId: string): Promise<DeleteAccepted> {
    const session = this.deletionSession()
    await this.exclusive(async () => {
      this.assertDeletionSession(session)
      const ledger = await this.readDeletions()
      this.assertDeletionSession(session)
      this.checkCanSend(conversationId)
      const record = ledger.records.find((t) => t.conversation === conversationId && t.scope === 'everyone' && t.localIntent && t.eventId === deletionEventId && t.author === this.myAccount())
      if (!record || !record.hash || !record.author || !record.requestAt || !timely(record.originalAt ?? 0, record.requestAt)) throw new Error('No accepted deletion intent')
      if (!this.deletionAllowed(conversationId)) throw new Error('Conversation unavailable')
      if (ledger.records.some((t) => t.remote && equivalent(t, record))) return
      if (!this.state.outbox.some((o) => o.conversationId === conversationId && o.messageId === deletionEventId)) await this.sendDeletionIntent(record, session)
    })
    this.assertDeletionSession(session)
    this.emit({ type: 'messages', conversationId })
    void this.flushOutbox()
    return { accepted: true, scope: 'everyone' }
  }

  private async sendDeletionIntent(record: DeletionRecord, session: ReturnType<Engine['deletionSession']>) {
    const id = record.eventId!
    this.acceptingDeletions.add(id)
    try {
      this.assertDeletionSession(session)
      this.checkCanSend(record.conversation)
      const ledger = await this.readDeletions()
      this.assertDeletionSession(session)
      if (!ledger.records.some((t) => t.localIntent && t.eventId === id && equivalent(t, record))) throw new Error('Deletion intent unavailable')
      if (!this.deletionAllowed(record.conversation)) throw new Error('Conversation unavailable')
      const core = session.core
      const envelope = core.sendDeletion(fromHex(record.conversation), fromHex(record.target), fromHex(record.hash!), fromHex(record.author!), record.requestAt!, fromHex(id))
      this.state.outbox.push({ conversationId: record.conversation, messageId: id, envelope: toBase64(envelope), recipients: this.recipients(record.conversation) })
      await this.changeDeletions((next) => { const intent = next.records.find((t) => t.eventId === id)!; intent.status = 'sending'; intent.error = undefined; return true })
      this.assertDeletionSession(session)
      await this.persist()
      this.assertDeletionSession(session)
    } catch (error) {
      try { this.assertDeletionSession(session) } catch { return }
      this.state.outbox = this.state.outbox.filter((o) => o.messageId !== id)
      // Persist the advanced ratchet, never roll it back. Local erasure is already accepted.
      try {
        this.assertDeletionSession(session)
        await this.changeDeletions((next) => { const intent = next.records.find((t) => t.eventId === id); if (!intent) return false; intent.status = 'failed'; intent.error = 'Deletion delivery is unconfirmed. Retry the request.'; return true })
        await this.persist()
      } catch { /* Recovery derives failure from an accepted intent without a queue item. */ }
    } finally {
      this.acceptingDeletions.delete(id)
    }
  }

  private applyDeletionEffects(record: DeletionRecord) {
    const conv = this.conv(record.conversation)
    if (conv) conv.lastText = undefined
    this.deletionPreviewsReady.delete(record.conversation)
    const targets = new Set([record.target, ...(record.aliases ?? [])])
    if (record.scope === 'everyone') this.state.outbox = this.state.outbox.filter((o) => o.conversationId !== record.conversation || !targets.has(o.messageId))
    this.state.live = this.state.live.filter((l) => !(l.conversationId === record.conversation && record.author === this.myAccount() &&
      (record.hash && l.binding?.author === record.author && l.binding.hash === record.hash || record.liveSession && l.sessionId === record.liveSession)))
    if (this.state.live.length === 0) this.liveFix = undefined
    this.state.liveSeen = this.state.liveSeen.filter((l) => l.conversationId !== record.conversation || !targets.has(l.messageId))
    this.state.transfers = this.state.transfers.filter((t) => !(t.conversationId === record.conversation && targets.has(t.messageId) && (record.scope === 'everyone' || t.kind === 'download')))
  }

  private async registerHiddenSend(conversationId: string, messageId: string) {
    const session = this.deletionSession()
    const key = 'hidden-send-index:' + session.accountId
    const refs = (await this.store.getJson<{ conversationId: string; messageId: string }[]>(key)) ?? []
    this.assertDeletionSession(session)
    if (refs.some((r) => r.conversationId === conversationId && r.messageId === messageId)) return
    // Discovery must commit before the capsule body. A failed rollback must remain discoverable.
    await this.store.putJson(key, [...refs, { conversationId, messageId }])
    this.assertDeletionSession(session)
  }

  private scheduleHiddenSendCleanup() {
    if (this.hiddenSendCleanupTimer || !this.account || this.endingSession) return
    const session = this.deletionSession()
    this.hiddenSendCleanupTimer = setTimeout(() => {
      this.hiddenSendCleanupTimer = undefined
      void this.exclusive(async () => { this.assertDeletionSession(session); await this.reconcileHiddenSends() }).catch(() => {
        try { this.assertDeletionSession(session) } catch { return }
        this.scheduleHiddenSendCleanup()
      })
    }, 5_000)
  }

  private async removeHiddenSend(conversationId: string, messageId: string) {
    const session = this.deletionSession()
    const capsuleKey = 'hidden-send:' + conversationId + ':' + messageId
    let absent = false
    try { absent = await this.store.getJson(capsuleKey) === undefined } catch { /* A malformed/unreadable record still needs physical deletion. */ }
    this.assertDeletionSession(session)
    try { if (!absent) await this.store.deleteBytes(capsuleKey) }
    catch (error) {
      this.assertDeletionSession(session)
      this.scheduleHiddenSendCleanup()
      throw error
    }
    this.assertDeletionSession(session)
    const key = 'hidden-send-index:' + session.accountId
    const refs = (await this.store.getJson<{ conversationId: string; messageId: string }[]>(key)) ?? []
    this.assertDeletionSession(session)
    const remaining = refs.filter((r) => r.conversationId !== conversationId || r.messageId !== messageId)
    // Never forget discovery until physical deletion succeeds. A stale index entry has no body.
    if (remaining.length !== refs.length) await this.store.putJson(key, remaining)
    this.assertDeletionSession(session)
    if (!remaining.length) { clearTimeout(this.hiddenSendCleanupTimer); this.hiddenSendCleanupTimer = undefined }
  }

  /** The caller holds the mutation lock, or startup has not connected yet. */
  private async reconcileHiddenSends(conversationId?: string) {
    const session = this.deletionSession()
    const refs = (await this.store.getJson<{ conversationId: string; messageId: string }[]>('hidden-send-index:' + session.accountId)) ?? []
    this.assertDeletionSession(session)
    const ledger = await this.readDeletions()
    for (const ref of refs) {
      if (conversationId !== undefined && ref.conversationId !== conversationId) continue
      const pending = this.state.transfers.some((t) => t.kind === 'upload' && t.conversationId === ref.conversationId && t.messageId === ref.messageId) ||
        this.state.outbox.some((o) => o.conversationId === ref.conversationId && o.messageId === ref.messageId)
      const records = ledger.records.filter((t) => t.conversation === ref.conversationId)
      // No tombstone means the readable original remains the transport source, not this duplicate.
      let needed = false
      if (pending && records.some((t) => t.scope === 'me')) {
        try {
          const rows = (await this.store.getJson<StoredMessage[]>('messages:' + ref.conversationId)) ?? []
          this.assertDeletionSession(session)
          const original = rows.find((m) => m.id === ref.messageId)
          const matches = (t: DeletionRecord) => original ? suppresses(t, original, ref.conversationId, this.myAccount()) : t.target === ref.messageId || t.aliases?.includes(ref.messageId)
          needed = records.some((t) => t.scope === 'me' && matches(t)) && !records.some((t) => t.scope === 'everyone' && matches(t))
        } catch { this.assertDeletionSession(session); continue }
      }
      if (!needed) await this.removeHiddenSend(ref.conversationId, ref.messageId).catch(() => undefined)
      this.assertDeletionSession(session)
    }
  }

  private async cleanupDeletion(conversationId: string) {
    const session = this.deletionSession()
    let ledger = await this.readDeletions()
    const raw = (await this.store.getJson<StoredMessage[]>('messages:' + conversationId)) ?? []
    this.assertDeletionSession(session)
    this.rememberDeletionOriginals(conversationId, raw)
    let changed = false
    ledger = await this.changeDeletions((next) => { changed = this.mergeDeletionEvidence(next, conversationId, raw); return changed })
    if (changed) this.emitDeletionBarrier(conversationId, ledger, raw)
    for (const record of ledger.records.filter((t) => t.conversation === conversationId)) this.applyDeletionEffects(record)
    const redacted = this.redactedHistory(conversationId, raw, ledger)
    await this.store.putJson('messages:' + conversationId, redacted)
    this.assertDeletionSession(session)
    this.refreshDeletionPreview(conversationId, redacted)
    for (const original of raw) {
      if (!ledger.records.some((t) => suppresses(t, original, conversationId, this.myAccount()))) continue
      const pendingMe = ledger.records.some((t) => t.scope === 'me' && suppresses(t, original, conversationId, this.myAccount())) &&
        (this.state.transfers.some((t) => t.kind === 'upload' && t.messageId === original.id) || this.state.outbox.some((o) => o.messageId === original.id))
      if (!pendingMe) {
        await this.store.putFile(original.id, undefined).catch(() => undefined)
        const parts = original.file ? Math.ceil(sealedLength(original.file.size) / transfers.PIECE_BYTES) : ledger.records.find((t) => suppresses(t, original, conversationId, this.myAccount()))?.fileParts
        if (parts !== undefined) for (let part = 0; part < parts; part++) await this.store.putFile(original.id + '#' + part, undefined).catch(() => undefined)
        await this.removeHiddenSend(conversationId, original.id).catch(() => undefined)
      }
    }
  }

  private async incomingDeletion(conversationId: string, binding: DeletionBinding, from: string) {
    if (from !== binding.author || !validBinding(binding) || binding.requestAt > this.deletionClock.now() + 2_000) return
    const raw = (await this.store.getJson<StoredMessage[]>('messages:' + conversationId)) ?? []
    const ledger = await this.changeDeletions((next) => {
      addCandidate(next, binding)
      this.mergeDeletionEvidence(next, conversationId, raw)
      return true
    })
    if (!ledger.records.some((t) => t.scope === 'everyone' && t.hash === binding.hash && t.author === from)) return
    for (const record of ledger.records.filter((t) => t.conversation === conversationId)) this.applyDeletionEffects(record)
    this.emitDeletionBarrier(conversationId, ledger, raw)
    await this.cleanupDeletion(conversationId).catch(() => undefined)
    this.emit({ type: 'messages', conversationId })
    this.emitView()
  }

  private async assertReadable(conversationId: string, messageId: string, session: ReturnType<Engine['deletionSession']>) {
    this.assertDeletionSession(session)
    const message = (await this.stored(conversationId)).find((m) => m.id === messageId)
    this.assertDeletionSession(session)
    if (!message || message.deleted) throw new Error('The message was deleted')
  }

  /** Messages for the UI: sender names resolved, attachment keys left out. */
  async messages(conversationId: string): Promise<ChatMessage[]> {
    const session = this.account ? this.deletionSession() : undefined
    return this.exclusive(async () => {
      if (session) this.assertDeletionSession(session)
      const now = Date.now()
      const list = await this.stored(conversationId)
      await this.recoverUnacceptedMessages(conversationId, list)
      const ledger = this.account ? await this.readDeletions() : emptyDeletions()
      if (ledger.records.some((t) => t.conversation === conversationId)) await this.cleanupDeletion(conversationId).catch(() => undefined)
      if (session) this.assertDeletionSession(session)
      const visible = list.filter((m) => !m.reactionEvent && !m.hidden)
      const replyLookup = buildReplyLookup(visible.filter((m) => !m.deleted))
      const originals = new Map<string, StoredMessage>()
      for (const m of visible) if (!m.deleted && m.kind !== 'notice' && !originals.has(m.id)) originals.set(m.id, m)
      const updates = list.flatMap((m) => m.reactionEvent ? [m.reactionEvent] : [])
      const reactionRecords = new Map(list.flatMap((m) => m.reactionEvent ? [[m.reactionEvent, m] as const] : []))
      const updatesByTarget = new Map<string, ReactionUpdate[]>()
      let changed = false
      for (const update of updates) {
        const bucket = updatesByTarget.get(update.target) ?? []
        bucket.push(update)
        updatesByTarget.set(update.target, bucket)
        if (!update.verified && validReaction(update) && bindingMatches(update, originals.get(update.target), this.myAccount())) {
          update.verified = true
          changed = true
        }
      }
      // Derived evidence must not hide readable history when storage is full.
      if (changed) await this.store.putJson('messages:' + conversationId, list).catch(() => undefined)
      if (session) this.assertDeletionSession(session)
      return visible.map(({ file, contentHash, replyToHash, reactionEvent: _event, hidden: _hidden, ...m }) => ({
        ...m,
        canDeleteForMe: m.kind !== 'notice',
        deleteForMeLocalOnly: !validMeBinding({ conversation: conversationId, hash: contentHash, author: m.from === 'me' ? this.myAccount() : m.from }),
        canDeleteForEveryone: !m.deleted && m.kind !== 'notice' && m.from === 'me' && validContentHash(contentHash) && this.deletionAllowed(conversationId) && newRequestTime(m.sentAt, this.deletionClock.now()) !== undefined,
        deleteForEveryoneUntil: !m.deleted && m.from === 'me' && validContentHash(contentHash) ? m.sentAt + DELETE_WINDOW_MS : undefined,
        deletionStatus: this.deletionStatus(conversationId, { ...m, contentHash }, ledger),
        canReact: !m.deleted && this.reactionAllowed(conversationId) && m.kind !== 'notice' && validReplyId(m.id) && validContentHash(contentHash) &&
          originals.get(m.id)?.contentHash === contentHash,
        reactions: originals.get(m.id)?.contentHash === contentHash
          ? reactionChips(reactionStates(updatesByTarget.get(m.id) ?? [], { ...m, contentHash }, this.myAccount()), this.myAccount()) : [],
        reactionStatus: this.reactionStatus(updatesByTarget.get(m.id) ?? [], reactionRecords, { ...m, contentHash }),
        canReply: !m.deleted && m.kind !== 'notice' && validReplyId(m.id) && validContentHash(contentHash) &&
          replyLookup.get(m.id)?.contentHash === contentHash,
        // An ended session shows no point, even before the sweep forgets it.
        live: m.live && (m.live.ended || m.live.expiresAt <= now ? { ...m.live, ended: true, latest: undefined } : m.live),
        fromName: m.from === 'me' || m.kind === 'notice' ? undefined : this.nameOf(m.from),
        reply: m.replyTo ? replyPreview(m.replyTo, replyLookup, (a) => a === 'me' ? 'You' : this.nameOf(a), replyToHash) : undefined,
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
    })
  }

  /** UI supplies only an ID and emoji. All target bindings come from encrypted worker history. */
  async react(conversationId: string, targetId: string, emoji: string) {
    const session = this.draftSession()
    await this.exclusive(async () => {
      this.assertReactionSession(session)
      this.checkCanSend(conversationId)
      this.checkCanReact(conversationId)
      const list = await this.stored(conversationId)
      this.assertReactionSession(session)
      const { core } = this.ready()
      const target = list.find((m) => !m.deleted && !m.reactionEvent && m.kind !== 'notice' && m.id === targetId)
      if (!target) throw new Error('The original message is unavailable')
      const updates = list.flatMap((m) => m.reactionEvent ? [m.reactionEvent] : [])
      const me = this.myAccount()
      const own = reactionStates(updates, target, me).find((r) => r.account === me)
      const nextEmoji = own?.emoji === emoji ? '' : emoji
      const author = target.from === 'me' ? me : target.from
      // A previously verified binding can authorize only removal after verification data disappears.
      const hash = validContentHash(target.contentHash) ? target.contentHash : nextEmoji === '' && own?.verified ? own.hash : undefined
      if (!hash) throw new Error('The original message cannot be verified on this device')
      const identity = splitIdentity(core.identity())
      const update: ReactionUpdate = {
        target: targetId, hash, author, account: me, device: toHex(identity.device),
        at: updates.reduce((at, r) => r.account === me && Number.isSafeInteger(r.at) ? Math.max(at, r.at + 1) : at, Date.now()),
        emoji: nextEmoji, verified: true,
      }
      if (!validReaction(update)) throw new Error('Invalid reaction')
      await this.acceptReaction(conversationId, update, list, session)
    })
    this.assertReactionSession(session)
    void this.flushOutbox()
  }

  private assertReactionSession(session: { accountId: string; epoch: number }) {
    if (this.endingSession || session.epoch !== this.draftEpoch || session.accountId !== this.account?.accountId) {
      throw new Error('The reaction session ended')
    }
  }

  private reactionAllowed(conversationId: string): boolean {
    const conv = this.conv(conversationId)
    return !this.endingSession && !!conv && !conv.status && !conv.request && this.state.pendingCommit?.conversationId !== conversationId &&
      (isGroupView(conv) || !conv.peers.some((p) => this.state.blocked.includes(p)))
  }

  private checkCanReact(conversationId: string) {
    this.checkCanSend(conversationId)
    if (!this.reactionAllowed(conversationId)) throw new Error('Reactions are unavailable')
  }

  private reactionStatus(updates: ReactionUpdate[], records: Map<ReactionUpdate, StoredMessage>, target: StoredMessage): ChatMessage['reactionStatus'] {
    if (target.kind === 'notice') return undefined
    const own = reactionStates(updates, target, this.myAccount()).find((r) => r.account === this.myAccount())
    const record = own && records.get(own)
    return record && (record.status === 'sending' || record.status === 'failed')
      ? { id: record.id, status: record.status, error: record.error } : undefined
  }

  /** The transport gate spans every acceptance write. The caller holds the mutation lock. */
  private async acceptReaction(conversationId: string, update: ReactionUpdate, list: StoredMessage[], session: { accountId: string; epoch: number }) {
    this.assertReactionSession(session)
    const { core } = this.ready()
    const id = toHex(randomId())
    const envelope = core.sendReaction(fromHex(conversationId), fromHex(update.target), fromHex(update.hash), fromHex(update.author), update.emoji, update.at, fromHex(id))
    this.acceptingReactions.add(id)
    this.state.outbox.push({ messageId: id, conversationId, envelope: toBase64(envelope), recipients: this.recipients(conversationId) })
    try {
      await this.recordReaction(conversationId, update, list, id)
      this.assertReactionSession(session)
      await this.persist()
      this.assertReactionSession(session)
    } catch (error) {
      // A rejected action must never become eligible in this or a later flush.
      // Keep the advanced ratchet. Cleanup must not replace the original error.
      this.state.outbox = this.state.outbox.filter((item) => item.messageId !== id)
      await this.setStatus(conversationId, id, 'failed', 'Not accepted on this device. Retry the reaction.').catch(() => undefined)
      await this.persist().catch(() => undefined)
      throw error
    } finally {
      this.acceptingReactions.delete(id)
    }
  }

  private async retryReaction(conversationId: string, messageId: string, session: { accountId: string; epoch: number }) {
    await this.exclusive(async () => {
      this.assertReactionSession(session)
      this.checkCanReact(conversationId)
      const list = await this.stored(conversationId)
      this.assertReactionSession(session)
      const failed = list.find((m) => m.id === messageId && m.status === 'failed' && m.reactionEvent)
      const previous = failed?.reactionEvent
      if (!previous || previous.account !== this.myAccount()) return
      const target = list.find((m) => !m.deleted && m.id === previous.target && m.kind !== 'notice')
      if (!target) throw new Error('The original message is unavailable')
      const updates = list.flatMap((m) => m.reactionEvent ? [m.reactionEvent] : [])
      const own = reactionStates(updates, target, this.myAccount()).find((r) => r.account === this.myAccount())
      if (own !== previous) throw new Error('A newer reaction replaced this update')
      if (!bindingMatches(previous, target, this.myAccount()) && !(previous.emoji === '' && previous.verified && !validContentHash(target.contentHash))) {
        throw new Error('The original message cannot be verified on this device')
      }
      // Retry is a new explicit edit. Retain the failed event and its ordering tombstone.
      const update = { ...previous,
        device: toHex(splitIdentity(this.core!.identity()).device),
        at: updates.reduce((at, r) => r.account === this.myAccount() ? Math.max(at, r.at + 1) : at, Date.now()),
      }
      if (!validReaction(update)) throw new Error('Invalid reaction')
      await this.acceptReaction(conversationId, update, list, session)
    })
    this.assertReactionSession(session)
    void this.flushOutbox()
  }

  private async recordReaction(conversationId: string, update: ReactionUpdate, list?: StoredMessage[], outgoingId?: string) {
    if (!validReaction(update)) return
    const deletionLedger = await this.readDeletions()
    if (deletionLedger.records.some((t) => t.conversation === conversationId && (t.hash ? t.hash === update.hash && t.author === update.author : t.target === update.target))) return
    list ??= await this.stored(conversationId)
    const original = list.find((m) => !m.reactionEvent && m.kind !== 'notice' && m.id === update.target)
    const anchor = list.some((m) => {
      const r = m.reactionEvent
      return r?.verified && r.target === update.target && r.hash === update.hash && r.author === update.author && r.account === update.account
    })
    update.verified = bindingMatches(update, original, this.myAccount()) || (update.emoji === '' && anchor)
    if (list.some((m) => {
      const r = m.reactionEvent
      return r && r.target === update.target && r.hash === update.hash && r.author === update.author &&
        r.account === update.account && r.device === update.device && r.at === update.at && r.emoji === update.emoji
    })) return
    // These worker-only records never enter visible history, unread counts, previews, or receipts.
    list.push({ id: outgoingId ?? '', from: outgoingId ? 'me' : '', kind: 'notice', text: '', sentAt: update.at, status: outgoingId ? 'sending' : 'received', reactionEvent: update })
    await this.store.putJson('messages:' + conversationId, list)
    this.emit({ type: 'messages', conversationId })
  }

  private typingNow(): number {
    return this.typingClock.now()
  }

  /** Order a new visible send after prior composition, not after later upload work. */
  private compositionSentAt(): number {
    const sentAt = Math.max(Date.now(), this.typingSentAt + 1)
    this.typingSentAt = sentAt
    return sentAt
  }

  /** Current typists, resolved from authenticated current group identities. */
  typing(conversationId: string): import('./protocol').Typist[] {
    const conv = this.conv(conversationId)
    if (!conv || conv.status || conv.self || conv.request || this.state.typingIndicators === false || this.connection !== 'online') {
      this.typingLeases.delete(conversationId)
      return []
    }
    const owners = this.deviceAccounts(conversationId)
    const accounts = this.typingLeases.get(conversationId)?.accounts(this.typingNow(), (device, account) =>
      owners.get(device) === account && account !== this.myAccount() && !this.state.blocked.includes(account)) ?? []
    return accounts.map((account) => ({ account, name: this.nameOf(account) }))
  }

  private stopTypingForMessage(conversationId: string, from: string, device: string, sentAt: number) {
    const conv = this.conv(conversationId)
    if (from === this.myAccount() || !conv || conv.status || conv.self || conv.request ||
        this.state.blocked.includes(from) || this.state.typingIndicators === false || this.connection !== 'online') return
    const leases = this.typingLeases.get(conversationId) ?? new TypingLeases()
    leases.stopDevice(device, from, sentAt, this.typingNow())
    this.typingLeases.set(conversationId, leases)
    this.publishTyping(conversationId)
    this.scheduleTypingSweep()
  }

  private publishTyping(conversationId: string) {
    const typists = this.typing(conversationId)
    const signature = JSON.stringify(typists)
    if ((this.typingPublished.get(conversationId) ?? '[]') === signature) return
    this.typingPublished.set(conversationId, signature)
    this.emit({ type: 'typing', conversationId, typists })
  }

  private scheduleTypingSweep() {
    this.typingTimer ??= setInterval(() => {
      for (const id of this.typingLeases.keys()) {
        this.publishTyping(id)
        if (this.typingLeases.get(id)?.empty(this.typingNow())) this.typingLeases.delete(id)
      }
      if (!this.typingLeases.size) {
        clearInterval(this.typingTimer)
        this.typingTimer = undefined
      }
    }, 250)
  }

  private clearTyping() {
    clearInterval(this.typingTimer)
    this.typingTimer = undefined
    this.typingLeases.clear()
    this.typingSent.clear()
    this.typingConversation = undefined
    for (const id of this.typingPublished.keys()) this.publishTyping(id)
    this.typingPublished.clear()
  }

  async setTypingIndicators(on: boolean) {
    this.ready()
    await this.exclusive(async () => {
      if (!on && this.typingConversation) await this.sendTypingLocked(this.typingConversation, false)
      this.state.typingIndicators = on
      if (!on) this.clearTyping()
      await this.persist()
    })
    this.emitView()
  }

  /** Best effort only: no typing envelope ever enters the persistent outbox. */
  async setTyping(conversationId: string, active: boolean) {
    await this.exclusive(async () => {
      if (active && this.typingConversation && this.typingConversation !== conversationId) {
        await this.sendTypingLocked(this.typingConversation, false)
      }
      await this.sendTypingLocked(conversationId, active)
    })
  }

  private async sendTypingLocked(conversationId: string, active: boolean) {
    const conv = this.conv(conversationId)
    if (!this.core || !this.account || !conv || conv.status || conv.self || conv.request ||
        this.state.typingIndicators === false || this.connection !== 'online' || this.state.pendingCommit ||
        (conv.peers.length === 1 && this.state.blocked.includes(conv.peers[0]))) return
    const now = this.typingNow()
    const last = this.typingSent.get(conversationId)
    if (active && last?.active && now - last.at < TYPING_REFRESH_MS) return
    if (!active && !last?.active) return
    // Stops must order after starts, even within one millisecond or after a clock change.
    const sentAt = Math.max(Math.ceil(now), this.typingSentAt + 1)
    this.typingSentAt = sentAt
    const envelope = this.core.sendTyping(fromHex(conversationId), active, sentAt, sentAt + TYPING_TTL_MS, randomId())
    // The MLS sender ratchet advances even if delivery subsequently fails.
    await this.persist()
    this.typingSent.set(conversationId, { active, at: now })
    if (active) this.typingConversation = conversationId
    else if (this.typingConversation === conversationId) this.typingConversation = undefined
    // No retries. Silent uses an existing generic delivery option, not a typing marker.
    void this.request((id) => encodeSend(id, envelope, this.recipients(conversationId).map(fromHex), true, [])).catch(() => undefined)
  }

  private async stored(conversationId: string): Promise<StoredMessage[]> {
    const session = this.account ? this.deletionSession() : undefined
    const raw = (await this.store.getJson<StoredMessage[]>(`messages:${conversationId}`)) ?? []
    if (session) this.assertDeletionSession(session)
    if (!this.account) return raw
    this.rememberDeletionOriginals(conversationId, raw)
    let ledger = await this.readDeletions()
    if (ledger.candidates.some((c) => c.conversation === conversationId)) {
      let promoted = false
      ledger = await this.changeDeletions((next) => { promoted = this.mergeDeletionEvidence(next, conversationId, raw); return promoted })
      if (promoted) this.emitDeletionBarrier(conversationId, ledger, raw)
    }
    for (const record of ledger.records.filter((t) => t.conversation === conversationId)) {
      this.applyDeletionEffects(record)
      for (const original of raw.filter((m) => suppresses(record, m, conversationId, this.myAccount()))) this.applyDeletionEffects({ ...record, target: original.id })
    }
    const redacted = this.redactedHistory(conversationId, raw, ledger)
    this.refreshDeletionPreview(conversationId, redacted)
    return redacted
  }

  /**
   * The conversation map entry for an id, via `Object.hasOwn` so that a
   * `__proto__` or `constructor` key cannot resolve to `Object.prototype`
   * (its fields look truthy and a later write would pollute it). Only used
   * for entries before they are written back to.
   */
  private conv(conversationId: string): Conversation | undefined {
    return Object.hasOwn(this.state.conversations, conversationId)
      ? this.state.conversations[conversationId]
      : undefined
  }

  private checkCanSend(conversationId: string) {
    if (this.state.pendingCommit?.conversationId === conversationId) {
      throw new Error('Finishing a group change; try again when you are back online')
    }
    if (this.state.conversations[conversationId]?.status) throw new Error("You're no longer in this group")
  }

  /** Shares a location once (FR-LOC-1); it travels only inside MLS. */
  /** The device's token, for requests the worker makes itself (map tiles). */
  token(): string | undefined {
    return this.account?.token
  }

  async sendLocation(conversationId: string, location: LocationInfo) {
    prepareArea(location.latitude, location.longitude, this.token())
    const { core } = this.ready()
    this.checkCanSend(conversationId)
    const checked = safeLocation(location.latitude, location.longitude, location.accuracyM, location.label ?? '')
    if (!checked) throw new Error("That location doesn't look right")
    await this.exclusive(async () => {
      const message: StoredMessage = {
        id: toHex(randomId()),
        from: 'me',
        text: '',
        sentAt: this.compositionSentAt(),
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

  private liveProducerAllowed(producer: LiveSession): boolean {
    const binding = producer.binding
    if (!binding || !validContentHash(binding.hash) || !validReplyId(binding.author) || !safeTime(binding.at) || binding.author !== this.myAccount()) return false
    const cache = this.deletionCache
    if (!cache || cache.accountId !== this.account?.accountId || cache.epoch !== this.draftEpoch || this.endingSession) return false
    return !cache.ledger.records.some((record) => suppresses(record, { id: producer.messageId, from: binding.author, contentHash: binding.hash, sentAt: binding.at }, producer.conversationId, this.myAccount()))
  }

  /** The caller holds the mutation lock, or startup has not connected yet. */
  private async reconcileLiveProducers() {
    const session = this.deletionSession()
    await this.readDeletions()
    let changed = false
    const retained: LiveSession[] = []
    for (const producer of this.state.live) {
      if (!producer.binding) {
        try {
          const rows = (await this.store.getJson<StoredMessage[]>('messages:' + producer.conversationId)) ?? []
          this.assertDeletionSession(session)
          const original = rows.find((m) => m.id === producer.messageId && m.from === 'me' && m.live?.sessionId === producer.sessionId && validContentHash(m.contentHash) && safeTime(m.sentAt))
          // Migrate only retained Native evidence. Never hash a normalized row or regenerate content.
          if (original?.contentHash) producer.binding = { hash: original.contentHash, author: this.myAccount(), at: original.sentAt }
        } catch { this.assertDeletionSession(session) }
        changed = true
      }
      if (this.liveProducerAllowed(producer)) retained.push(producer)
      else changed = true
    }
    this.state.live = retained
    if (!retained.length) this.liveFix = undefined
    return changed
  }

  /** Starts sharing in one conversation for a fixed duration or until stopped. */
  async startLive(conversationId: string, durationMs: number | null, location: LocationInfo) {
    const operation = this.deletionSession()
    prepareArea(location.latitude, location.longitude, this.token())
    const { core } = operation
    this.checkCanSend(conversationId)
    if (durationMs !== null && !(LIVE_DURATIONS_MS as readonly number[]).includes(durationMs)) {
      throw new Error('Choose 15 minutes, 1 hour, 8 hours or until stopped')
    }
    const untilStopped = durationMs === null
    const point = safeLocation(location.latitude, location.longitude, location.accuracyM, '')
    if (!point) throw new Error("That location doesn't look right")
    // Replacing a session can wait on storage while the composer starts a newer draft.
    const now = await this.exclusive(async () => { this.assertDeletionSession(operation); return this.compositionSentAt() })
    this.assertDeletionSession(operation)
    await this.stopLive(conversationId)
    await this.exclusive(async () => {
      this.assertDeletionSession(operation)
      const session: LiveSession = {
        sessionId: toHex(randomId()),
        conversationId,
        messageId: toHex(randomId()),
        expiresAt: now + (durationMs ?? MAX_LIVE_DURATION_MS),
        untilStopped,
        lastSentAt: now,
        last: point,
      }
      const message: StoredMessage = {
        id: session.messageId,
        from: 'me',
        text: '',
        sentAt: now,
        status: 'sending',
        live: {
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          untilStopped,
          latest: { ...point, at: now },
          ended: false,
        },
      }
      this.state.outbox.push({
        messageId: message.id,
        conversationId,
        envelope: toBase64(this.encode(core, conversationId, message)),
        recipients: this.recipients(conversationId),
      })
      if (validContentHash(message.contentHash)) session.binding = { hash: message.contentHash, author: splitIdentity(core.identity()).account, at: message.sentAt }
      this.state.live.push(session)
      await this.appendMessage(conversationId, message)
      await this.persist()
    })
    this.scheduleLiveSweep()
    void this.flushOutbox()
  }

  /** Forget the cached fix when the page cannot provide foreground updates. */
  pauseLive() {
    this.liveFix = undefined
  }

  /**
   * A new fix from the page. Each running session sends it if it moved
   * enough or a heartbeat is due, and only while online: updates queued
   * offline would arrive stale. Resuming renews the same card, not a new post.
   */
  async liveUpdate(location: LocationInfo) {
    const session = this.deletionSession()
    const generation = this.deletionGeneration
    const point = safeLocation(location.latitude, location.longitude, location.accuracyM, '')
    if (!point) return
    // Kept for the sweep: the page reports only changes, so a move held back
    // by the rate floor, and the heartbeat, go out from there.
    await this.exclusive(async () => {
      this.assertDeletionSession(session)
      if (await this.reconcileLiveProducers()) await this.persist()
    })
    this.assertDeletionSession(session)
    if (!this.state.live.length) return
    this.liveFix = point
    if (this.connection !== 'online') return
    await this.endExpiredLive()
    this.assertDeletionSession(session)
    if (generation !== this.deletionGeneration) return
    let sent = false
    await this.exclusive(async () => {
      const { core } = this.ready()
      this.assertDeletionSession(session)
      if (generation !== this.deletionGeneration) return
      const now = Date.now()
      for (const session of this.state.live) {
        if (!this.liveProducerAllowed(session)) continue
        if (this.state.conversations[session.conversationId]?.status) continue
        if (!updateDue(now, session.lastSentAt, session.last, point)) continue
        const untilStopped = session.untilStopped === true
        const resume = untilStopped && session.expiresAt <= now
        const expiresAt = expiryForUpdate(now, session.expiresAt, untilStopped)
        const messageId = randomId()
        const envelope = core.sendLiveLocation(
          fromHex(session.conversationId),
          fromHex(session.sessionId),
          expiresAt,
          untilStopped,
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
        session.expiresAt = expiresAt
        session.lastSentAt = now
        session.last = point
        await this.setLivePoint(
          session.conversationId,
          session.messageId,
          { ...point, at: now },
          expiresAt,
          untilStopped,
          resume,
        )
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
      const now = Date.now()
      this.state.live = this.state.live.filter((l) => l !== session)
      await this.endLiveMessage(conversationId, session.messageId, true)
      const conv = this.state.conversations[conversationId]
      const untilStopped = session.untilStopped === true
      if (this.core && conv && !conv.status && (untilStopped || session.expiresAt > now)) {
        const messageId = randomId()
        const expiresAt = untilStopped ? now + MAX_LIVE_DURATION_MS : session.expiresAt
        const envelope = this.core.sendLiveLocation(
          fromHex(conversationId),
          fromHex(session.sessionId),
          expiresAt,
          untilStopped,
          false,
          0,
          0,
          0,
          now,
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
    if (signal.group) return this.startGroupCall(conversationId, signal)
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
        false,
        now,
        messageId,
      )
      // Offers with a device are ICE restarts in a call under way.
      const direct = signal.toDevice && (signal.kind === 'candidate' || signal.kind === 'busy' || signal.kind === 'offer')
      this.state.outbox.push({
        messageId: toHex(messageId),
        conversationId,
        envelope: toBase64(envelope),
        recipients: direct ? [signal.toDevice!] : this.recipients(conversationId),
        silent: signal.kind !== 'offer' || !!direct,
      })
      await this.trackCall(conversationId, signal, true, true, now)
      await this.persist()
    })
    void this.flushOutbox()
  }

  /** Tells the group a call started in its LiveKit room (ADR-0031). */
  private async startGroupCall(conversationId: string, signal: CallSignal) {
    const conv = this.group(conversationId)
    if (conv.status || conv.self || !this.isGroupConversation(conv)) throw new Error('Group calls work in groups')
    if (signal.kind !== 'offer') return
    if (this.connection !== 'online') throw new Error("You're offline")
    await this.exclusive(async () => {
      const { core } = this.ready()
      const messageId = randomId()
      const now = Date.now()
      const envelope = core.sendCall(
        fromHex(conversationId),
        fromHex(signal.callId),
        CALL_KINDS.indexOf('offer'),
        '',
        '',
        signal.video ?? false,
        new Uint8Array(),
        true,
        now,
        messageId,
      )
      this.state.outbox.push({
        messageId: toHex(messageId),
        conversationId,
        envelope: toBase64(envelope),
        recipients: this.recipients(conversationId),
      })
      await this.noteGroupCall(conv, signal, 'You', now)
      await this.persist()
    })
    void this.flushOutbox()
  }

  /** Remembers a group call and notes it in the conversation (under the lock). */
  private async noteGroupCall(conv: Conversation, signal: CallSignal, by: string, at: number) {
    this.state.groupCalls ??= {}
    this.state.groupCalls[conv.id] = { callId: signal.callId, video: !!signal.video, startedAt: at }
    await this.appendMessage(conv.id, {
      id: toHex(randomId()),
      from: '',
      kind: 'notice',
      text: `${signal.video ? '🎥' : '📞'} ${by} started a group ${signal.video ? 'video' : 'voice'} call`,
      sentAt: at,
      status: 'received',
    })
  }

  private isGroupConversation(conv: Conversation): boolean {
    return conv.name !== undefined || conv.peers.length > 1
  }

  /** A LiveKit URL and room token for a group call (ADR-0031). */
  async groupCallJoin(conversationId: string, callId: string): Promise<{ url: string; token: string }> {
    const conv = this.group(conversationId)
    if (conv.status || !this.isGroupConversation(conv)) throw new Error('Group calls work in groups')
    return api.callJoin(this.ready().account.token, toBase64(fromHex(conversationId)), toBase64(fromHex(callId)))
  }

  /** The group's latest call, if people are still in it. */
  async groupCallStatus(
    conversationId: string,
  ): Promise<{ callId: string; video: boolean; participants: number } | undefined> {
    const call = this.state.groupCalls?.[conversationId]
    if (!call || Date.now() - call.startedAt > 12 * 3600_000) return undefined
    const { participants } = await api.callStatus(
      this.ready().account.token,
      toBase64(fromHex(conversationId)),
      toBase64(fromHex(call.callId)),
    )
    return participants > 0 ? { ...call, participants } : undefined
  }

  /** Display names of a conversation's member devices (hex), for call tiles. */
  deviceNames(conversationId: string): Record<string, string> {
    const { core } = this.ready()
    const me = this.myAccount()
    const names: Record<string, string> = {}
    for (const m of core.members(fromHex(conversationId)) as Uint8Array[]) {
      const { account, device } = splitIdentity(m)
      names[toHex(device)] = account === me ? 'You' : this.nameOf(account)
    }
    return names
  }

  /**
   * Encrypts (send) or decrypts (receive) one RTP sender's or receiver's
   * encoded frames with the call's SFrame keys (ADR-0030).
   */
  attachMedia(readable: ReadableStream, writable: WritableStream, options: MediaTransformOptions) {
    const session = this.callMedia(options.conversationId, options.callId)
    const seal =
      options.direction === 'send'
        ? (data: Uint8Array, clear: number) => session.encrypt(data, clear)
        : (data: Uint8Array, clear: number) => session.decrypt(data, clear)
    void readable
      .pipeThrough(frameTransform(options, seal))
      .pipeTo(writable)
      .catch(() => undefined)
  }

  private callMedia(conversationId: string, callId: string): CallMedia {
    if (this.endedCalls.has(callId)) {
      throw new Error('this call already ended on this device')
    }
    const known = this.media.get(callId)
    if (known) {
      if (known.conversationId !== conversationId) throw new Error('call belongs to another conversation')
      return known.media
    }
    const conv = this.state.conversations[conversationId]
    if (!conv || conv.status || conv.self || conv.peers.length === 0) throw new Error('No call in this conversation')
    if (!/^[0-9a-f]{32}$/.test(callId)) throw new Error('malformed call id')
    const media = new CallMedia()
    this.ready().core.installCallKeys(fromHex(conversationId), fromHex(callId), media)
    this.media.set(callId, { conversationId, media, createdAt: Date.now() })
    this.callTimer ??= setInterval(() => void this.sweepCalls(), 15_000)
    return media
  }

  /** After an epoch change: calls in the conversation move to the new epoch's keys. */
  private refreshCallKeys(conversationId: string) {
    for (const [callId, entry] of this.media) {
      if (entry.conversationId !== conversationId) continue
      try {
        this.core!.installCallKeys(fromHex(conversationId), fromHex(callId), entry.media)
      } catch (e) {
        console.warn('updating call keys failed', e)
      }
    }
  }

  private forgetMedia(callId: string) {
    this.media.get(callId)?.media.free()
    this.media.delete(callId)
    this.endedCalls.add(callId)
  }

  /** A signal from the other person or another of our devices (under the lock). */
  private async applyCall(conv: Conversation, mine: boolean, device: string, sentAt: number, signal: CallSignal) {
    const now = Date.now()
    const thisDevice = deviceHex(this.ready().account.deviceId)
    const forThis = !signal.toDevice || signal.toDevice === thisDevice
    const known = this.calls.get(signal.callId)
    if (known && known.conversationId !== conv.id) return
    if (signal.kind === 'offer' && known) {
      // An ICE restart in a call under way (ADR-0028), for this device.
      if (known.answeredAt !== undefined && !mine && signal.toDevice === thisDevice) {
        this.emit({
          type: 'call',
          signal: { ...signal, conversationId: conv.id, title: this.title(conv), fromDevice: device },
        })
      }
      return
    }
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
    this.forgetMedia(callId)
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
    // Keys of calls that never got going (e.g. the camera was refused).
    for (const [callId, entry] of this.media) {
      if (!this.calls.has(callId) && now - entry.createdAt > GIVE_UP_MS) this.forgetMedia(callId)
    }
    if (this.calls.size === 0 && this.media.size === 0) {
      clearInterval(this.callTimer)
      this.callTimer = undefined
    }
  }

  /** Moves the point and refreshes its lease (under the lock). */
  private async setLivePoint(
    conversationId: string,
    messageId: string,
    latest: LocationInfo & { at: number },
    expiresAt: number,
    untilStopped: boolean,
    resume = false,
  ) {
    const list = await this.stored(conversationId)
    const message = list.find((m) => m.id === messageId)
    if (!message?.live || (message.live.ended && !resume) || message.live.stopped) return
    message.live.ended = false
    message.live.latest = latest
    message.live.expiresAt = expiresAt
    message.live.untilStopped = untilStopped
    await this.store.putJson(`messages:${conversationId}`, list)
    this.emit({ type: 'messages', conversationId })
  }

  /** Ends a live message and forgets its point (doc 06: discard at the end). Under the lock. */
  private async endLiveMessage(conversationId: string, messageId: string, stopped = false) {
    const list = await this.stored(conversationId)
    const message = list.find((m) => m.id === messageId)
    if (!message?.live) return false
    const changed = !message.live.ended || message.live.latest !== undefined || (stopped && !message.live.stopped)
    if (!changed) return false
    message.live.ended = true
    message.live.latest = undefined
    if (stopped) message.live.stopped = true
    await this.store.putJson(`messages:${conversationId}`, list)
    this.emit({ type: 'messages', conversationId })
    return true
  }

  /** Expires timed sessions and clears points whose rolling leases ran out. */
  private async endExpiredLive() {
    const now = Date.now()
    if (!this.state.live.some((l) => l.expiresAt <= now) && !this.state.liveSeen.some((l) => l.expiresAt <= now)) return
    let changed = false
    await this.exclusive(async () => {
      const expiredLive = this.state.live.filter((l) => l.expiresAt <= now)
      const expiredSeen = this.state.liveSeen.filter((l) => l.expiresAt <= now)
      if (expiredLive.length === 0 && expiredSeen.length === 0) return
      for (const l of [...expiredLive, ...expiredSeen]) {
        changed = (await this.endLiveMessage(l.conversationId, l.messageId)) || changed
      }
      // Keep until-stopped sender sessions so they can resume when the page opens.
      // Their expired cards must not trigger storage writes on every later sweep.
      changed = changed || expiredLive.some((l) => !l.untilStopped) || expiredSeen.length > 0
      this.state.live = this.state.live.filter((l) => l.untilStopped === true || l.expiresAt > now)
      this.state.liveSeen = this.state.liveSeen.filter((l) => l.expiresAt > now)
      if (changed) await this.persist()
    })
    if (changed) this.emitView()
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
    reference: Pick<StoredMessage, 'contentHash' | 'replyTo' | 'replyToHash'> = {},
  ) {
    const sessionId = view.sessionId.length === 16 ? toHex(view.sessionId) : undefined
    const place = view.location
    const ledger = await this.readDeletions()
    if (ledger.records.some((t) => t.conversation === conversationId && t.author === from && t.liveSession === sessionId)) { place?.free(); return }
    const point = place && safeLocation(place.latitude, place.longitude, place.accuracyM, '')
    if (point) prepareArea(point.latitude, point.longitude, this.token())
    place?.free()
    if (!sessionId || !plausibleExpiry(view.expiresAtMs, sentAt)) return
    const list = await this.stored(conversationId)
    const sender = mine ? 'me' : from
    // Only the session's own sender can move or stop it.
    const shown = list.find((m) => m.live?.sessionId === sessionId && m.from === sender)
    if (shown?.live) {
      if ((shown.live.untilStopped === true) !== view.untilStopped) return
      if (view.stopped) {
        await this.endLiveMessage(conversationId, shown.id, true)
        this.state.liveSeen = this.state.liveSeen.filter(
          (l) => l.conversationId !== conversationId || l.messageId !== shown.id,
        )
        return
      }
      const now = Date.now()
      if (shown.live.stopped || view.expiresAtMs <= now) return
      if (
        shown.live.ended &&
        !canResumeUntilStopped(shown.live.ended, shown.live.stopped ?? false, view.untilStopped, view.expiresAtMs, now)
      ) {
        return
      }
      if (point && sentAt > (shown.live.latest?.at ?? 0)) {
        await this.setLivePoint(
          conversationId,
          shown.id,
          { ...point, at: sentAt },
          view.expiresAtMs,
          view.untilStopped,
          shown.live.ended,
        )
        const seen = this.state.liveSeen.find((l) => l.conversationId === conversationId && l.messageId === shown.id)
        if (seen) seen.expiresAt = view.expiresAtMs
        else {
          this.state.liveSeen.push({ conversationId, messageId: shown.id, expiresAt: view.expiresAtMs })
          this.scheduleLiveSweep()
        }
      }
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
      ...reference,
      sentAt,
      status: mine ? 'sent' : 'received',
      live: {
        sessionId,
        expiresAt: view.expiresAtMs,
        untilStopped: view.untilStopped,
        latest: ended ? undefined : { ...point, at: sentAt },
        ended,
      },
    })
    if (!ended) {
      this.state.liveSeen.push({ conversationId, messageId, expiresAt: view.expiresAtMs })
      this.scheduleLiveSweep()
    }
    return true
  }

  /** A device-local read. A late UI response must not replace newer typing. */
  async getDraft(conversationId: string): Promise<Draft> {
    const session = this.draftSession()
    return this.exclusive(async () => {
      this.assertDraftSession(session)
      if (!this.conv(conversationId)) throw new Error('Conversation not found')
      const draft = await this.readDraft(conversationId, session.accountId)
      this.assertDraftSession(session)
      return this.conv(conversationId)?.status ? { text: '', revision: draft.revision } : draft
    })
  }

  /** CAS is serialized within this engine only. It does not synchronize tabs. */
  async saveDraft(conversationId: string, text: string, expectedRevision: number): Promise<DraftSave> {
    const session = this.draftSession()
    if (typeof text !== 'string') throw new Error('Draft text must be a string')
    this.requireDraftRevision(expectedRevision)
    return this.exclusive(async () => {
      this.assertDraftSession(session)
      const conv = this.conv(conversationId)
      if (!conv || conv.status) throw new Error('This conversation cannot accept a draft')
      const current = await this.readDraft(conversationId, session.accountId)
      this.assertDraftSession(session)
      if (current.revision !== expectedRevision) return { applied: false, draft: current }
      const draft = { text, revision: this.nextDraftRevision(current.revision) }
      await this.store.putJson(this.draftKey(conversationId, session.accountId), draft)
      this.assertDraftSession(session)
      this.emit({ type: 'draft', conversationId, draft })
      return { applied: true, draft }
    })
  }

  private draftSession() {
    return { accountId: this.ready().account.accountId, epoch: this.draftEpoch }
  }

  private assertDraftSession(session: { accountId: string; epoch: number }) {
    if (session.epoch !== this.draftEpoch || session.accountId !== this.account?.accountId) throw new Error('The draft session ended')
  }

  private draftKey(conversationId: string, accountId: string) {
    return `draft:${accountId}:${conversationId}`
  }

  private requireDraftRevision(revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid draft revision')
  }

  private nextDraftRevision(revision: number) {
    this.requireDraftRevision(revision)
    if (revision === Number.MAX_SAFE_INTEGER) throw new Error('Draft revision limit reached')
    return revision + 1
  }

  private async readDraft(conversationId: string, accountId: string): Promise<Draft> {
    const saved = await this.store.getJson<Draft>(this.draftKey(conversationId, accountId))
    const fence = Object.hasOwn(this.state.draftClears, conversationId) ? this.state.draftClears[conversationId] : 0
    this.requireDraftRevision(fence)
    if (!saved) return { text: '', revision: fence }
    this.requireDraftRevision(saved.revision)
    if (typeof saved.text !== 'string') throw new Error('Invalid saved draft')
    return saved.revision > fence ? saved : { text: '', revision: fence }
  }

  /** Caller owns the engine lock and persists the fence with its lifecycle change. */
  private async invalidateDraft(conversationId: string) {
    const draft = await this.readDraft(conversationId, this.ready().account.accountId)
    const cleared = { text: '', revision: this.nextDraftRevision(draft.revision) }
    this.state.draftClears[conversationId] = cleared.revision
    this.draftChanges.set(conversationId, cleared)
  }

  async sendText(conversationId: string, text: string, replyTo?: string, draftRevision?: number): Promise<TextSent> {
    const { core } = this.ready()
    const session = this.draftSession()
    if (draftRevision !== undefined) this.requireDraftRevision(draftRevision)
    const result = await this.exclusive(async (): Promise<TextSent> => {
      this.assertDraftSession(session)
      this.checkCanSend(conversationId)
      if (!this.conv(conversationId)) throw new Error('Conversation not found')
      const current = draftRevision === undefined ? undefined : await this.readDraft(conversationId, session.accountId)
      this.assertDraftSession(session)
      // Keep the stop and message ahead of typing requests from a newer draft.
      await this.sendTypingLocked(conversationId, false)
      const messageId = randomId()
      const sentAt = this.compositionSentAt()
      const target = replyTo && (await this.stored(conversationId)).find((m) => !m.deleted && m.id === replyTo && m.kind !== 'notice')
      if (replyTo && (!validReplyId(replyTo) || !target)) throw new Error('The reply target is not in this conversation')
      if (target && !validContentHash(target.contentHash)) throw new Error('The original message cannot be verified on this device. Cancel the reply and send a new message.')
      const message: StoredMessage = {
        id: toHex(messageId), from: 'me', text, replyTo,
        replyToHash: target ? target.contentHash : undefined, sentAt, status: 'sending',
      }
      const envelope = this.encode(core, conversationId, message)
      this.acceptingText.add(message.id)
      this.state.outbox.push({
        messageId: toHex(messageId),
        conversationId,
        envelope: toBase64(envelope),
        recipients: this.recipients(conversationId),
      })
      try {
        await this.appendMessage(conversationId, message)
        // The ratchet advanced: persist before anything leaves the device.
        this.assertDraftSession(session)
        return await this.persistDraftAcceptance(conversationId, text, draftRevision, current, session.accountId)
      } catch (error) {
        // Never transmit an action that the UI saw rejected. Keep the advanced ratchet.
        this.state.outbox = this.state.outbox.filter((item) => item.messageId !== message.id)
        await this.setStatus(conversationId, message.id, 'failed', 'Not accepted on this device. Try again.').catch(() => undefined)
        throw error
      } finally {
        this.acceptingText.delete(message.id)
      }
    })
    void this.flushOutbox()
    return result
  }

  /** The caller holds the engine lock and has added the outbox or upload-resume entry. */
  private async persistDraftAcceptance(conversationId: string, text: string, draftRevision: number | undefined, current: Draft | undefined, accountId: string): Promise<TextSent> {
    const consumed = current !== undefined && current.revision === draftRevision && current.text.trim() === text.trim()
    const previousFence = this.state.draftClears[conversationId]
    const previousChange = this.draftChanges.get(conversationId)
    if (consumed) {
      const cleared = { text: '', revision: this.nextDraftRevision(current.revision) }
      this.state.draftClears[conversationId] = cleared.revision
      this.draftChanges.set(conversationId, cleared)
    }
    try {
      // The local send queue and clearing fence share this encrypted app record.
      await this.persist()
    } catch (error) {
      if (consumed) {
        if (previousFence === undefined) delete this.state.draftClears[conversationId]
        else this.state.draftClears[conversationId] = previousFence
        if (previousChange === undefined) this.draftChanges.delete(conversationId)
        else this.draftChanges.set(conversationId, previousChange)
      }
      throw error
    }
    if (consumed) {
      // Cleanup is best effort. A durable accepted send must remain accepted.
      await this.store.deleteBytes(this.draftKey(conversationId, accountId)).catch(() => undefined)
    }
    if (!current) return {}
    if (!consumed) return { draft: current }
    const consumedRevision = this.state.draftClears[conversationId]
    return { draft: { text: '', revision: consumedRevision }, consumedRevision }
  }

  /**
   * Sends a message again after it failed for good: re-encrypted for the
   * group as it is now, under the same message id.
   */
  async retryMessage(conversationId: string, messageId: string) {
    const session = this.draftSession()
    const conv = this.group(conversationId)
    if (conv.status) throw new Error("You're no longer in this conversation")
    const failed = (await this.stored(conversationId)).find((m) => !m.deleted && m.id === messageId && m.status === 'failed')
    this.assertReactionSession(session)
    if (failed?.reactionEvent) return this.retryReaction(conversationId, messageId, session)
    if (failed?.file && !failed.file.blobId) {
      // The upload failed: start over from the sealed copy kept here.
      await this.exclusive(() => this.setStatus(conversationId, messageId, 'sending'))
      void this.uploadAndSend(conversationId, messageId)
      return
    }
    await this.exclusive(async () => {
      this.assertReactionSession(session)
      const list = await this.stored(conversationId)
      this.assertReactionSession(session)
      const { core } = this.ready()
      const message = list.find((m) => !m.deleted && m.id === messageId && m.from === 'me' && m.status === 'failed')
      if (!message) return
      const envelope = this.encode(core, conversationId, message)
      if (message.live && validContentHash(message.contentHash)) {
        const producer = this.state.live.find((l) => l.conversationId === conversationId && l.messageId === messageId && l.sessionId === message.live!.sessionId)
        if (producer) producer.binding = { hash: message.contentHash, author: splitIdentity(core.identity()).account, at: message.live.untilStopped ? message.live.expiresAt - MAX_LIVE_DURATION_MS : message.sentAt }
      }
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
    const envelope = this.encodeBody(core, conversationId, m)
    // No other send can run between encryption and this getter: the caller holds the lock.
    m.contentHash = hashHex(core.lastSentContentHash)
    return envelope
  }

  private encodeBody(core: CoreClient, conversationId: string, m: StoredMessage): Uint8Array {
    if (m.deleted) throw new Error('The message was deleted')
    const id = fromHex(m.id)
    if (m.replyTo && (!validReplyId(m.replyTo) || !validContentHash(m.replyToHash))) {
      throw new Error('The original message cannot be verified on this device. Cancel the reply and send a new message.')
    }
    const replyTo = m.replyTo ? fromHex(m.replyTo) : undefined
    const replyToHash = m.replyToHash ? fromHex(m.replyToHash) : undefined
    if (m.live) {
      const p = m.live.latest
      return core.sendLiveLocation(
        fromHex(conversationId),
        fromHex(m.live.sessionId),
        m.live.expiresAt,
        m.live.untilStopped === true,
        !!p,
        p?.latitude ?? 0,
        p?.longitude ?? 0,
        p?.accuracyM ?? 0,
        m.live.untilStopped === true ? m.live.expiresAt - MAX_LIVE_DURATION_MS : m.sentAt,
        id,
      )
    }
    if (m.location) {
      const l = m.location
      return core.sendLocation(fromHex(conversationId), l.latitude, l.longitude, l.accuracyM, l.label ?? '', m.sentAt, id, replyTo, replyToHash)
    }
    if (!m.file) return core.sendText(fromHex(conversationId), m.text, m.sentAt, id, replyTo, replyToHash)
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
      return core.sendAttachment(fromHex(conversationId), view, m.sentAt, id, replyTo, replyToHash)
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
  async sendFile(conversationId: string, file: File, caption: string, media?: MediaInfo, draftRevision?: number): Promise<TextSent> {
    const session = this.draftSession()
    if (draftRevision !== undefined) this.requireDraftRevision(draftRevision)
    this.checkCanSend(conversationId)
    if (file.size === 0) throw new Error('That file is empty')
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Files can be up to 100 MB')
    // Capture the user action before preparation and upload can overlap a newer draft.
    const sentAt = await this.exclusive(async () => {
      this.assertDraftSession(session)
      if (!this.conv(conversationId)) throw new Error('Conversation not found')
      this.checkCanSend(conversationId)
      return this.compositionSentAt()
    })
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
    const result = await this.exclusive(async () => {
      this.assertDraftSession(session)
      this.checkCanSend(conversationId)
      const current = draftRevision === undefined ? undefined : await this.readDraft(conversationId, session.accountId)
      this.assertDraftSession(session)
      const message: StoredMessage = {
        id: messageId,
        from: 'me',
        text: caption,
        sentAt,
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
      }
      const previousTransfers = this.state.transfers
      let historyStored = false
      try {
        await this.store.putFile(messageId, sealed.body)
        await this.appendMessage(conversationId, message)
        historyStored = true
        this.assertDraftSession(session)
        this.state.transfers = [...previousTransfers, { conversationId, messageId, kind: 'upload' }]
        return await this.persistDraftAcceptance(conversationId, caption, draftRevision, current, session.accountId)
      } catch (error) {
        this.state.transfers = previousTransfers
        if (historyStored) {
          // Keep the sealed body for explicit retry; never leave an unqueued sending card.
          await this.setStatus(conversationId, messageId, 'failed', 'Not accepted on this device. Try again.').catch(() => undefined)
        } else {
          await this.store.putFile(messageId, undefined).catch(() => undefined)
        }
        throw error
      }
    })
    void this.uploadAndSend(conversationId, messageId)
    return result
  }

  /** Remembers a transfer to resume, or forgets it (`add` false). */
  private async trackTransfer(conversationId: string, messageId: string, kind: 'upload' | 'download', add: boolean) {
    const session = this.deletionSession()
    await this.exclusive(async () => {
      this.assertDeletionSession(session)
      if (add && kind === 'download') await this.assertReadable(conversationId, messageId, session)
      if (add && kind === 'upload' && !(await this.uploadSource(conversationId, messageId, session))?.file) return
      this.assertDeletionSession(session)
      const others = this.state.transfers.filter((t) => t.messageId !== messageId)
      this.state.transfers = add ? [...others, { conversationId, messageId, kind }] : others
      await this.persist()
    })
  }

  /** Updates one stored attachment's details under the lock. */
  private async updateFile(conversationId: string, messageId: string, change: Partial<StoredFile>) {
    const session = this.deletionSession()
    await this.exclusive(async () => {
      this.assertDeletionSession(session)
      const list = await this.stored(conversationId)
      this.assertDeletionSession(session)
      const message = list.find((m) => m.id === messageId)
      if (message?.deleted && 'uploadId' in change) {
        const source = await this.uploadSource(conversationId, messageId, session)
        if (source?.file) {
          source.file.uploadId = change.uploadId
          const { text, sentAt, replyTo, replyToHash, file } = source
          await this.registerHiddenSend(conversationId, messageId)
          await this.store.putJson('hidden-send:' + conversationId + ':' + messageId, { text, sentAt, replyTo, replyToHash, file })
          this.assertDeletionSession(session)
        }
        return
      }
      if (!message?.file || message.deleted) return
      Object.assign(message.file, change)
      await this.store.putJson(`messages:${conversationId}`, list)
    })
  }

  private progress(conversationId: string, messageId: string): transfers.Progress {
    const session = this.deletionSession()
    const generation = this.deletionGeneration
    return (done, total) => {
      if (generation !== this.deletionGeneration || this.endingSession || session.epoch !== this.draftEpoch || session.accountId !== this.account?.accountId) return
      this.emit({ type: 'progress', conversationId, messageId, done, total })
    }
  }

  /** Picks up uploads and downloads cut short by a reload or lost connection. */
  private resumeTransfers() {
    for (const t of this.state.transfers) {
      if (t.kind === 'upload') void this.uploadAndSend(t.conversationId, t.messageId)
      else void this.fetchAttachment(t.conversationId, t.messageId).catch(() => undefined)
    }
  }

  private async uploadSource(conversationId: string, messageId: string, session: ReturnType<Engine['deletionSession']>): Promise<StoredMessage | undefined> {
    this.assertDeletionSession(session)
    const current = (await this.stored(conversationId)).find((m) => m.id === messageId)
    this.assertDeletionSession(session)
    if (!current?.deleted) return current
    const capsule = await this.store.getJson<Pick<StoredMessage, 'text' | 'sentAt' | 'replyTo' | 'replyToHash' | 'file'>>('hidden-send:' + conversationId + ':' + messageId)
    const ledger = await this.readDeletions()
    this.assertDeletionSession(session)
    if (!capsule || !this.state.transfers.some((t) => t.kind === 'upload' && t.conversationId === conversationId && t.messageId === messageId) || ledger.records.some((t) => t.scope === 'everyone' && suppresses(t, current, conversationId, this.myAccount()))) return undefined
    return { ...capsule, id: messageId, from: 'me', status: 'sending' }
  }

  private async uploadAndSend(conversationId: string, messageId: string) {
    if (this.inflight.has(messageId)) return
    const session = this.deletionSession()
    this.inflight.add(messageId)
    try {
      await this.exclusive(async () => { this.assertDeletionSession(session); await this.reconcileHiddenSends(conversationId).catch(() => this.scheduleHiddenSendCleanup()) })
      const pending = await this.uploadSource(conversationId, messageId, session)
      if (!pending?.file || pending.status !== 'sending') return
      await this.trackTransfer(conversationId, messageId, 'upload', true)
      this.assertDeletionSession(session)
      let blobId = pending.file.blobId
      if (!blobId) {
        const body = await this.store.getFile(messageId)
        this.assertDeletionSession(session)
        if (!body || !(await this.uploadSource(conversationId, messageId, session))?.file) throw new Error('This file is no longer on this device')
        const upload = { id: pending.file.uploadId, save: async (uploadId: string | undefined) => {
          this.assertDeletionSession(session)
          await this.updateFile(conversationId, messageId, { uploadId })
          this.assertDeletionSession(session)
        } }
        blobId = uuidToHex(await transfers.upload(this.ready().account.token, body, upload, this.progress(conversationId, messageId)))
      }
      await this.exclusive(async () => {
        this.assertDeletionSession(session)
        this.checkCanSend(conversationId)
        await this.reconcileHiddenSends(conversationId).catch(() => this.scheduleHiddenSendCleanup())
        const message = await this.uploadSource(conversationId, messageId, session)
        this.assertDeletionSession(session)
        if (!message?.file || message.status !== 'sending') return
        message.file.blobId = blobId
        const envelope = this.encode(session.core, conversationId, message)
        this.state.outbox.push({ messageId, conversationId, envelope: toBase64(envelope), recipients: this.recipients(conversationId) })
        const list = await this.stored(conversationId)
        this.assertDeletionSession(session)
        const visible = list.findIndex((m) => m.id === messageId && !m.deleted)
        if (visible >= 0) list[visible] = message
        await this.store.putJson('messages:' + conversationId, list)
        this.assertDeletionSession(session)
        this.state.transfers = this.state.transfers.filter((t) => t.messageId !== messageId)
        await this.persist()
        this.assertDeletionSession(session)
      })
      this.assertDeletionSession(session)
      void this.flushOutbox()
    } catch (error) {
      try { this.assertDeletionSession(session) } catch { return }
      if (this.connection !== 'online' && !(error instanceof ApiError)) return
      await this.trackTransfer(conversationId, messageId, 'upload', false)
      await this.exclusive(async () => {
        this.assertDeletionSession(session)
        await this.setStatus(conversationId, messageId, 'failed', describeError(error))
        await this.removeHiddenSend(conversationId, messageId).catch(() => undefined)
        await this.cleanupDeletion(conversationId).catch(() => undefined)
        await this.reconcileHiddenSends(conversationId).catch(() => this.scheduleHiddenSendCleanup())
      })
    } finally {
      this.inflight.delete(messageId)
    }
  }

  private fetchAttachment(conversationId: string, messageId: string): Promise<Blob> {
    const running = this.downloads.get(messageId)
    if (running) return running
    const session = this.deletionSession()
    const readable = () => this.assertReadable(conversationId, messageId, session)
    const run = (async () => {
      await readable()
      const f = (await this.stored(conversationId)).find((m) => m.id === messageId)?.file
      await readable()
      if (!f) throw new Error('No such file')
      const kept = await this.store.getFile(messageId)
      await readable()
      if (kept) return kept
      if (!f.blobId) throw new Error('This file was not uploaded')
      const total = sealedLength(f.size)
      await this.trackTransfer(conversationId, messageId, 'download', true)
      // Fence every chunk read/write, including cache writes after a delayed HTTP response.
      const guardedStore = new Proxy(this.store, { get: (store, key) => {
        if (key === 'getFile') return async (id: string) => { await readable(); const body = await store.getFile(id); await readable(); return body }
        if (key === 'putFile') return async (id: string, body: Blob | undefined) => {
          if (body) await readable()
          await store.putFile(id, body)
          if (body) { try { await readable() } catch (error) { await store.putFile(id, undefined).catch(() => undefined); throw error } }
        }
        return Reflect.get(store, key)
      } })
      try {
        const body = await transfers.download(this.ready().account.token, hexToUuid(f.blobId), total, guardedStore, messageId, this.progress(conversationId, messageId))
        await readable()
        await this.updateFile(conversationId, messageId, { downloaded: true })
        await readable()
        await this.trackTransfer(conversationId, messageId, 'download', false)
        await readable()
        this.emit({ type: 'messages', conversationId })
        return body
      } catch (error) {
        this.assertDeletionSession(session)
        if (error instanceof ApiError || this.connection === 'online') await this.trackTransfer(conversationId, messageId, 'download', false)
        throw error
      }
    })()
    this.downloads.set(messageId, run)
    void run.catch(() => undefined).finally(() => { if (this.downloads.get(messageId) === run) this.downloads.delete(messageId) })
    return run
  }

  async openAttachment(conversationId: string, messageId: string): Promise<Blob> {
    const session = this.deletionSession()
    await this.assertReadable(conversationId, messageId, session)
    const f = (await this.stored(conversationId)).find((m) => m.id === messageId)?.file
    await this.assertReadable(conversationId, messageId, session)
    if (!f) throw new Error('No such file')
    const body = await this.fetchAttachment(conversationId, messageId)
    await this.assertReadable(conversationId, messageId, session)
    try {
      const type = isPhoto(f.mime) || isPlayable(f.mime) ? f.mime : 'application/octet-stream'
      const opened = await openFile(body, fromBase64(f.key), f.size, fromBase64(f.digest), type)
      await this.assertReadable(conversationId, messageId, session)
      return opened
    } catch (error) {
      this.assertDeletionSession(session)
      await this.store.putFile(messageId, undefined)
      await this.updateFile(conversationId, messageId, { downloaded: undefined })
      throw new Error(`This file could not be opened: ${describeError(error)}`)
    }
  }

  // ---- WebSocket -------------------------------------------------------------

  private connect() {
    if (!this.account || this.ws || this.endingSession) return
    const session = this.draftSession()
    const url = new URL('/v1/ws', self.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.setConnection('connecting')

    const currentSocket = () => this.ws === ws && !this.endingSession &&
      session.epoch === this.draftEpoch && session.accountId === this.account?.accountId
    ws.onopen = () => {
      if (currentSocket()) ws.send(plain(encodeAuthenticate(this.requestId(), this.account!.token)))
    }
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
    ws.onmessage = (event) => {
      // Stale callbacks must not decode frames or touch a replacement session.
      if (currentSocket()) this.onFrame(decodeServerFrame(new Uint8Array(event.data as ArrayBuffer)), currentSocket)
    }
    ws.onclose = () => {
      if (!currentSocket()) return // replaced or signed out
      this.ws = undefined
      for (const resolve of this.waiters.values()) resolve(undefined)
      this.waiters.clear()
      this.setConnection('offline')
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs)
      this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS)
    }
  }

  private onFrame(frame: ServerFrameView, currentSocket: () => boolean = () => true) {
    if (!currentSocket()) return
    switch (frame.kind) {
      case 'auth':
        this.reconnectMs = 1000
        this.setConnection('online')
        void this.replenishKeyPackages(frame.keyPackages, currentSocket)
        // Queued before any delivery handler, so it settles first.
        void this.exclusive(async () => {
          if (currentSocket()) await this.resolvePendingCommit()
        }).then(() => {
          if (!currentSocket()) return
          this.commitDepartures()
          this.scheduleSync()
          this.resumeTransfers()
          return this.flushOutbox()
        })
        return
      case 'deliver':
        void this.onDeliver(frame, currentSocket)
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

  private async onDeliver(frame: ServerFrameView, currentSocket: () => boolean = () => true) {
    const { envelope, messageId } = frame
    await this.exclusive(async () => {
      if (!currentSocket()) return
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
      }
      // A previous write can fail after this in-memory ID was marked as seen.
      // Retry that durable commit before acknowledging a duplicate delivery.
      await this.persist()
    })
    // Never acknowledge an old socket delivery on a replacement connection.
    if (!currentSocket()) return
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
        ...new Set(
          (core.members(fromHex(conversationId)) as Uint8Array[])
            .map((m) => trySplitIdentity(m)?.account)
            .filter((a): a is string => a !== undefined),
        ),
      ]
      if (designatedCommitter(conv.admins, members, leavers) !== this.myAccount()) return
      await this.flushOutbox(true)
      const everyone = this.recipients(conversationId)
      const staged = core.commitProposals(fromHex(conversationId), randomId())
      const pending: PendingCommit = { conversationId, commitHash: toBase64(staged.commitHash) }
      // The leavers are the members this commit takes out (ADR-0035).
      const after = this.withoutAccounts(conversationId, leavers)
      // A conflict means another member committed first; nothing to do.
      await this.sendCommit(pending, staged.commit, everyone, undefined, after)
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
        // A commit removed us (or committed our own departure). End local live points.
        conv.status ??= 'removed'
        await this.invalidateDraft(conversationId)
        const localSessions = this.state.live.filter((l) => l.conversationId === conversationId)
        const seenSessions = this.state.liveSeen.filter((l) => l.conversationId === conversationId)
        this.state.live = this.state.live.filter((l) => l.conversationId !== conversationId)
        this.state.liveSeen = this.state.liveSeen.filter((l) => l.conversationId !== conversationId)
        for (const l of [...localSessions, ...seenSessions]) await this.endLiveMessage(conversationId, l.messageId, true)
        this.emitView()
        return
      }
      await this.observeKeysIn(conversationId)
      this.refreshCallKeys(conversationId)
      if (conv.self) return
      await this.endRemovedPeerLiveLocations(conversationId, conv.peers, peers)
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
        await this.invalidateDraft(conversationId)
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
      if (event.deletionTarget !== undefined || event.deletionTargetHash !== undefined || event.deletionTargetAuthor !== undefined) {
        if (!conv || conv.status || event.deletionTarget?.length !== 16 || event.deletionTargetHash?.length !== 32 || event.deletionTargetAuthor?.length !== 16) return
        await this.incomingDeletion(conversationId, { conversation: conversationId, target: toHex(event.deletionTarget), hash: toHex(event.deletionTargetHash), author: toHex(event.deletionTargetAuthor), requestAt: event.sentAtMs }, from)
        return
      }
      if (event.reaction !== undefined) {
        if (!conv || conv.status || conv.request || this.state.blocked.includes(from)) return
        const bytes = event.reaction
        if (bytes.length < 64) return
        await this.recordReaction(conversationId, {
          target: toHex(bytes.slice(0, 16)), hash: toHex(bytes.slice(16, 48)),
          author: toHex(bytes.slice(48, 64)), emoji: new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(64)),
          account: from, device: toHex(splitIdentity(event.sender).device), at: event.sentAtMs,
        })
        return
      }
      if (event.typingActive !== undefined) {
        if (!mine && conv && !conv.status && !conv.self && !conv.request && !this.state.blocked.includes(from) && this.state.typingIndicators !== false && this.connection === 'online') {
          const leases = this.typingLeases.get(conversationId) ?? new TypingLeases()
          leases.update(toHex(splitIdentity(event.sender).device), from, event.typingActive, event.sentAtMs, event.typingExpiresAtMs ?? NaN, this.typingNow())
          this.typingLeases.set(conversationId, leases)
          this.publishTyping(conversationId)
          this.scheduleTypingSweep()
        }
        return
      }
      if (event.deviceSync !== undefined) {
        // Only this account's own devices may edit the local account (blocked
        // list, display name): audit H1. A device linked a moment ago is not
        // in the local list yet, so hold its sync until the server confirms it
        // rather than dropping it.
        const senderDevice = toHex(splitIdentity(event.sender).device)
        if (mine && this.state.myDevices.includes(senderDevice)) {
          await this.applyDeviceSync(conversationId, event.deviceSync, senderDevice)
        } else if (mine) {
          // Retain normalized input before a consumed MLS ratchet can be persisted or acknowledged.
          // This is not acceptance: directory and private-self checks still gate replay after reload.
          if (this.privateSelfContext(conversationId, senderDevice, false)) this.stageMeDeletionInput(conversationId, senderDevice, parseMeDeletions(event.deviceSync))
          this.pendingSyncs.push({
            conversationId,
            device: senderDevice,
            bytes: new Uint8Array(event.deviceSync),
            accountId: this.ready().account.accountId, epoch: this.draftEpoch,
          })
          void this.syncOwnDevices()
        }
        return
      }
      if (event.receiptKind !== undefined) {
        if (!mine && conv) await this.applyReceipts(conversationId, from, event.receiptKind === 1, event.receiptIds)
        return
      }
      if (
        event.groupName !== undefined &&
        conv &&
        !conv.status &&
        acceptsGroupInfo(conv.admins, from)
      ) {
        if (event.groupName) conv.name = event.groupName.slice(0, 64)
        const admins = parseAdmins(event.groupAdmins)
        if (admins.length > 0) conv.admins = admins
        this.emitView()
      }
      const callView = event.call
      if (callView) {
        const signal = parseCall(callView)
        callView.free()
        const oneToOne = conv && !conv.status && !conv.self && conv.peers.length === 1 && !conv.name
        if (signal?.group && conv && !conv.status && !conv.request && this.isGroupConversation(conv)) {
          if (signal.kind === 'offer' && !mine && !this.state.blocked.includes(from)) {
            await this.noteGroupCall(conv, signal, this.nameOf(from), event.sentAtMs)
            if (Date.now() - event.sentAtMs < STALE_OFFER_MS) {
              const device = toHex(splitIdentity(event.sender).device)
              this.emit({
                type: 'call',
                signal: { ...signal, conversationId, title: this.title(conv), fromDevice: device },
              })
            }
          } else if (signal.kind === 'offer' && mine) {
            // Started on another of our devices.
            this.state.groupCalls ??= {}
            this.state.groupCalls[conversationId] = { callId: signal.callId, video: !!signal.video, startedAt: event.sentAtMs }
          }
        } else if (signal && oneToOne && !this.state.blocked.includes(from)) {
          const device = toHex(splitIdentity(event.sender).device)
          await this.applyCall(conv, mine, device, event.sentAtMs, signal)
        }
        return
      }
      const live = event.live
      if (live) {
        if (!conv?.status && !this.state.blocked.includes(from)) {
          const reference = event.replyTo && toHex(event.replyTo)
          const added = await this.applyLive(conversationId, from, mine, messageId, event.sentAtMs, live, {
            contentHash: hashHex(event.contentHash),
            replyTo: reference && validReplyId(reference) ? reference : undefined,
            replyToHash: hashHex(event.replyToHash),
          })
          // Only a new visible card ends composition. Background session updates do not.
          if (added) this.stopTypingForMessage(conversationId, from, toHex(splitIdentity(event.sender).device), event.sentAtMs)
        }
        live.free()
        return
      }
      const view = event.attachment
      const attachment = view && this.receivedFile(view)
      const place = event.location
      const location = place && safeLocation(place.latitude, place.longitude, place.accuracyM, place.label)
      if (location) prepareArea(location.latitude, location.longitude, this.token())
      place?.free()
      // An unusable attachment is dropped with its caption, and a bad location with it.
      const text = view ? attachment && view.caption : place ? location && '' : event.text
      view?.free()
      if (conv?.status && text !== undefined) return // no longer in the group
      if (this.state.blocked.includes(from)) return // blocked (FR-ID-8)
      if (event.displayName !== undefined && !mine) {
        this.state.names[from] = event.displayName.slice(0, 64)
        this.setPeerAvatar(from, event.avatar)
        this.emitView()
        // Sender names are resolved when messages are read: refresh lists.
        for (const c of Object.values(this.state.conversations)) {
          if (c.peers.includes(from)) this.emit({ type: 'messages', conversationId: c.id })
        }
      }
      if (text !== undefined) {
        this.stopTypingForMessage(conversationId, from, toHex(splitIdentity(event.sender).device), event.sentAtMs)
        const reference = event.replyTo && toHex(event.replyTo)
        const replyTo = reference && validReplyId(reference) ? reference : undefined
        if (!mine && conv) {
          conv.unread = (conv.unread ?? 0) + 1
          if (!conv.request) this.queueReceipt(conversationId, 'delivered', messageId)
        }
        // Sent from another of our devices: show it as ours.
        await this.appendMessage(conversationId, {
          id: messageId,
          from: mine ? 'me' : from,
          text,
          replyTo,
          replyToHash: hashHex(event.replyToHash),
          contentHash: hashHex(event.contentHash),
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
    if (this.flushing || this.connection !== 'online' || this.endingSession || !this.account) return
    const session = this.draftSession()
    const currentSession = () => !this.endingSession && session.epoch === this.draftEpoch && session.accountId === this.account?.accountId
    this.flushing = true
    try {
      while (currentSession() && this.state.outbox.length > 0 && this.connection === 'online') {
        const item = this.state.outbox[0]
        if (item.meDeletionBatch && (!this.privateSelfContext(item.conversationId) || this.recipients(item.conversationId).sort().join(',') !== [...item.recipients].sort().join(','))) {
          const cancel = async () => {
            if (!currentSession()) return
            const batch = item.meDeletionBatch!
            const removed = this.state.outbox.filter((o) => o.meDeletionBatch === batch)
            this.state.outbox = this.state.outbox.filter((o) => o.meDeletionBatch !== batch)
            for (const old of removed) this.acceptingMeDeletionSync.delete(old.messageId)
            if (this.state.meDeletionBatches) delete this.state.meDeletionBatches[batch]
            await this.persist()
            this.scheduleMeDeletionSync()
          }
          await (locked ? cancel() : this.exclusive(cancel))
          continue
        }
        if (this.acceptingText.has(item.messageId) || this.acceptingReactions.has(item.messageId) || this.acceptingDeletions.has(item.messageId) || this.acceptingMeDeletionSync.has(item.messageId)) return
        const result = await this.request((id) =>
          encodeSend(
            id,
            fromBase64(item.envelope),
            item.recipients.map(fromHex),
            item.silent ?? false,
            [],
          ),
        )
        if (!currentSession() || !result) return // disconnected or invalidated: do not settle another session
        // A request sent before invalidation cannot be recalled.
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
          if (!currentSession()) return
          if (!this.state.outbox.includes(item)) return // Deletion can cancel an in-flight original.
          this.state.outbox = this.state.outbox.filter((queued) => queued !== item)
          if (item.meDeletionBatch) await this.settleMeDeletionBatch(item, outcome.kind === 'failed')
          if (outcome.kind === 'failed')
            await this.setStatus(item.conversationId, item.messageId, 'failed', outcome.reason)
          else await this.setStatus(item.conversationId, item.messageId, 'sent')
          await this.removeHiddenSend(item.conversationId, item.messageId).catch(() => undefined)
          await this.cleanupDeletion(item.conversationId).catch(() => undefined)
          await this.reconcileHiddenSends(item.conversationId).catch(() => this.scheduleHiddenSendCleanup())
          await this.persist()
        }
        await (locked ? settle() : this.exclusive(settle))
      }
    } finally {
      this.flushing = false
      // One handoff only when the session changed. A same-session timeout or
      // retry response must retain its existing reconnect/backoff behavior.
      if (!currentSession() && !this.endingSession && this.account && this.connection === 'online' && this.state.outbox.length > 0) {
        void this.flushOutbox()
      }
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
    /**
     * Devices that are members once the server accepts this commit
     * (ADR-0035). Without it the server keeps the old member list, and a
     * removed member keeps send and call access.
     */
    membersAfter?: string[],
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
            (membersAfter ?? []).map(fromHex),
          )
        : encodeSend(requestId, commit, recipients.map(fromHex), false, (membersAfter ?? []).map(fromHex)),
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
    const conv = this.conv(p.conversationId)
    this.core!.confirmCommit(fromHex(p.conversationId))
    this.refreshCallKeys(p.conversationId)
    if (conv && !conv.self) {
      const peers = this.peersOf(p.conversationId)
      await this.endRemovedPeerLiveLocations(p.conversationId, conv.peers, peers)
      conv.peers = peers
    }
    if (conv) await this.observeKeysIn(p.conversationId)
    if (!this.core!.hasPendingProposals(fromHex(p.conversationId))) delete this.state.leaving[p.conversationId]
    if (p.invitees && conv?.self) {
      await this.queueDeviceSync(p.conversationId)
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

  /** Clears all other members' live points in a conversation we left. Under the lock (issue #114). */
  private async endGroupLiveLocations(conversationId: string) {
    const seen = this.state.liveSeen.filter((l) => l.conversationId === conversationId)
    this.state.liveSeen = this.state.liveSeen.filter((l) => l.conversationId !== conversationId)
    const ids = new Set(seen.map((l) => l.messageId))
    for (const m of await this.stored(conversationId)) if (m.live && !m.live.ended) ids.add(m.id)
    for (const id of ids) await this.endLiveMessage(conversationId, id)
  }

  private async endRemovedPeerLiveLocations(conversationId: string, previousPeers: string[], peers: string[]) {
    const removedAccounts = previousPeers.filter((p) => !peers.includes(p))
    if (removedAccounts.length === 0) return
    const list = await this.stored(conversationId)
    const removedIds = list
      .filter((m) => removedAccounts.includes(m.from) && m.live && !m.live.ended)
      .map((m) => m.id)
    for (const messageId of removedIds) await this.endLiveMessage(conversationId, messageId, true)
    this.state.liveSeen = this.state.liveSeen.filter(
      (l) => l.conversationId !== conversationId || !removedIds.includes(l.messageId),
    )
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
      const account = f.account_id.replaceAll('-', '')
      const deviceIds = devices.map((d) => d.replaceAll('-', ''))
      const identities = deviceIds.map((d) => makeIdentity(account, d))
      const keyPackages = devices.map((d) => fromBase64(claimed.key_packages[d]))
      this.checkIdentities(identities, keyPackages)
      return { username: f.username, account, devices: deviceIds, identities, keyPackages }
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
    const conv = this.state.conversations[conversationId]
    if (!conv || (conv.peers.length === 1 && !isGroupView(conv) && this.state.blocked.includes(conv.peers[0]))) return
    if (!this.account!.displayName) return // linked device still waiting for its name
    const conversation = this.state.conversations[conversationId]
    if (
      conversation &&
      conversation.name === undefined &&
      conversation.peers.length === 1 &&
      this.state.blocked.includes(conversation.peers[0])
    ) {
      return
    }
    const messageId = randomId()
    const avatar = this.account!.avatar ? fromBase64(this.account!.avatar) : new Uint8Array()
    const envelope = this.core!.sendProfile(
      fromHex(conversationId),
      this.account!.displayName,
      avatar,
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

  /**
   * Device ids (hex) of every member, this device included. A member whose
   * identity is not 32 bytes is skipped: it cannot be addressed, and it must
   * not stop the rest of the group from sending (audit H1).
   */
  private memberDevices(conversationId: string): string[] {
    return (this.core!.members(fromHex(conversationId)) as Uint8Array[])
      .map((m) => trySplitIdentity(m))
      .filter((m): m is { account: string; device: Uint8Array; deviceId: string } => m !== undefined)
      .map((m) => m.deviceId)
  }

  /** Device id (hex) to account id (hex), from the core's group state. */
  private deviceAccounts(conversationId: string): Map<string, string> {
    const owners = new Map<string, string>()
    for (const m of this.core!.members(fromHex(conversationId)) as Uint8Array[]) {
      const split = trySplitIdentity(m)
      if (split) owners.set(split.deviceId, split.account)
    }
    return owners
  }

  /** Member devices after every device of `accounts` leaves. */
  private withoutAccounts(conversationId: string, accounts: string[]): string[] {
    const owners = this.deviceAccounts(conversationId)
    return this.memberDevices(conversationId).filter((d) => !accounts.includes(owners.get(d) ?? ''))
  }

  /** Device ids (hex) of every member except this device. */
  private recipients(conversationId: string): string[] {
    const me = toHex(splitIdentity(this.core!.identity()).device)
    return this.memberDevices(conversationId).filter((d) => d !== me)
  }

  private myAccount(): string {
    return this.account ? this.account.accountId.replaceAll('-', '') : ''
  }

  /** Other members' account ids, from the core's current group state. */
  private peersOf(conversationId: string): string[] {
    const me = this.myAccount()
    const accounts = (this.core!.members(fromHex(conversationId)) as Uint8Array[])
      .map((m) => trySplitIdentity(m)?.account)
      .filter((a): a is string => a !== undefined)
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
    this.rememberDeletionOriginals(conversationId, list)
    let changed = false
    const ledger = await this.changeDeletions((next) => { changed = this.mergeDeletionEvidence(next, conversationId, list); return changed })
    if (changed) this.emitDeletionBarrier(conversationId, ledger, list)
    const redacted = this.redactedHistory(conversationId, list, ledger)
    for (const record of ledger.records.filter((t) => suppresses(t, message, conversationId, this.myAccount()))) this.applyDeletionEffects({ ...record, target: message.id })
    await this.store.putJson(`messages:${conversationId}`, redacted)
    this.refreshDeletionPreview(conversationId, redacted)
    if (redacted.find((m) => m.id === message.id)?.deleted) {
      this.emit({ type: 'messages', conversationId })
      this.emitView()
      return
    }
    const conv = this.conv(conversationId)
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
    if (this.account) {
      const ledger = await this.readDeletions()
      if (ledger.records.some((t) => t.localIntent && t.conversation === conversationId && t.eventId === messageId)) {
        await this.changeDeletions((next) => {
          const intent = next.records.find((t) => t.localIntent && t.conversation === conversationId && t.eventId === messageId)!
          intent.acknowledged = status === 'sent'
          intent.status = status === 'failed' ? 'failed' : undefined
          intent.error = status === 'failed' ? 'Deletion delivery is unconfirmed. Retry the request.' : undefined
          return true
        })
        this.emit({ type: 'messages', conversationId })
        return
      }
    }
    const list = await this.stored(conversationId)
    const message = list.find((m) => m.id === messageId)
    // A receipt may already have moved it past 'sent'.
    if (!message || (status === 'sent' && message.status !== 'sending')) return
    message.status = status
    message.error = error
    await this.store.putJson(`messages:${conversationId}`, list)
    this.emit({ type: 'messages', conversationId })
  }

  /** Recover only loaded history. The caller holds the lock, excluding provisional acceptance. */
  private async recoverUnacceptedMessages(conversationId: string, list: StoredMessage[]) {
    const queued = new Set([
      ...this.state.outbox.map((item) => item.messageId),
      ...this.state.transfers.filter((item) => item.kind === 'upload').map((item) => item.messageId),
    ])
    let changed = false
    for (const message of list) {
      if (message.from !== 'me' || message.status !== 'sending' || queued.has(message.id)) continue
      // The sealed body, if any, remains available for an explicit retry.
      message.status = 'failed'
      message.error = 'Not accepted on this device. Try again.'
      changed = true
    }
    // This is derived display recovery, not send acceptance. Keep readable history available.
    if (changed) await this.store.putJson(`messages:${conversationId}`, list).catch(() => undefined)
  }

  private async persist() {
    this.backupDirty = true
    this.state.seen = this.recent.toJSON()
    // Retain already decrypted own-device input before persisting a consumed MLS ratchet.
    // If both ledger and app writes fail, replay must not lose the only normalized input.
    if (this.state.pendingMeDeletions) await this.store.putJson('me-deletion-inbox:' + this.ready().account.accountId, this.state.pendingMeDeletions)
    await this.store.putBytes('core', this.core!.snapshot())
    await this.store.putJson('app', this.state)
    this.acceptingMeDeletionSync.clear()
    for (const [conversationId, draft] of this.draftChanges) this.emit({ type: 'draft', conversationId, draft })
    this.draftChanges.clear()
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
    if (state !== 'online') this.clearTyping()
    this.emitView()
    if (state === 'online') void this.reportCallStats()
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
  if (kind === 'offer' && view.group) return { ...signal, group: true, video: view.video }
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

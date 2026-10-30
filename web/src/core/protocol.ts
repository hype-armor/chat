// Messages between the UI thread and the core worker. The worker owns all
// keys, storage and network connections; the UI only renders `AppView`.

import type { MapInfo } from './maps'

export type ConnectionState = 'offline' | 'connecting' | 'online'

export type ConversationSummary = {
  id: string
  title: string
  isGroup: boolean
  amAdmin: boolean
  /** 'left' / 'removed': read-only history. */
  status: 'active' | 'left' | 'removed' | 'restoring'
  /** Including this user. */
  memberCount: number
  /** 1:1 chats: the other person's account id. */
  peer?: string
  /** From someone with no connection to this user, until accepted (FR-SAF-3). */
  request: boolean
  /** Received messages not seen yet. */
  unread: number
  /** 1:1 chats: this user blocked the other person (FR-ID-8). */
  blocked?: boolean
  /** 1:1 chats: safety number status of the other person (ADR-0020). */
  verification?: Verification
  lastText?: string
  lastAt: number
}

export type AppView =
  | { phase: 'loading' }
  | {
      phase: 'signed-out'
      /** Why the last session ended, e.g. this device was removed. */
      notice?: string
    }
  | {
      phase: 'ready'
      me: { username: string; displayName: string }
      connection: ConnectionState
      conversations: ConversationSummary[]
      /** New devices on this account that nobody here approved (ADR-0020). */
      alerts: { id: string; text: string }[]
      /** Whether this user sends read receipts (FR-MSG-5). */
      readReceipts: boolean
      /** Encrypted backups are on (ADR-0022), with the last upload time. */
      backup?: { lastAt?: number }
      media: MediaSettings
    }

/** When attachments download by themselves (FR-MED-6, ADR-0025). */
export type AutoDownload = 'always' | 'wifi' | 'never'

export type MediaSettings = {
  photos: AutoDownload
  audio: AutoDownload
  video: AutoDownload
  files: AutoDownload
  /** Photos: 'standard' fits 2560 px; 'high' fits 4096 px at higher quality (FR-MED-5). */
  quality: 'standard' | 'high'
}

/** One of this account's devices (ADR-0019). */
export type DeviceInfo = { id: string; addedOn: string; lastSeenOn?: string; current: boolean }

/** An invite link to share, and the same as a QR code (ADR-0021). */
export type InviteOffer = { link: string; expiresInDays: number; qrSize: number; qrModules: number[] }

/** A link code to show on a new device: text for typing, QR modules for scanning. */
export type LinkOffer = { code: string; qrSize: number; qrModules: number[] }

export type Verification = 'unverified' | 'verified' | 'changed'

/** 60 digits to compare, and the same as a QR code to scan. */
export type SafetyNumber = { digits: string; qrSize: number; qrModules: number[] }

export type MemberInfo = {
  account: string
  name: string
  isAdmin: boolean
  isMe: boolean
  verification?: Verification
  blocked?: boolean
}

export type ReportReason = 'spam' | 'harassment' | 'other'

export type BlockedContact = { account: string; name: string }

/** Shown inline as photos; everything else is offered as a download. */
export function isPhoto(mime: string): boolean {
  return /^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(mime)
}

/** Played inline (audio and video elements run no script). */
export function isPlayable(mime: string): boolean {
  return /^(audio\/(webm|ogg|mp4|mpeg|aac|wav|x-m4a)|video\/(mp4|webm|quicktime))$/.test(mime)
}

/** What the UI thread learns about a clip before sending it (it can decode media; the worker can't). */
export type MediaInfo = {
  durationMs?: number
  width?: number
  height?: number
  /** A JPEG frame for videos. */
  thumbnail?: Uint8Array<ArrayBuffer>
  /** Recorded in the app. */
  voiceNote?: boolean
}

/** An image or file in a message (ADR-0024). */
export type FileInfo = {
  name: string
  mime: string
  /** Bytes. */
  size: number
  /** Images: pixel size and a small JPEG preview. */
  width?: number
  height?: number
  thumbnail?: Uint8Array<ArrayBuffer>
  /** Audio and video. */
  durationMs?: number
  voiceNote?: boolean
  /** Kept on this device, so it opens without a download. */
  downloaded?: boolean
}

/** A location shared once (FR-LOC-1). */
export type LocationInfo = {
  latitude: number
  longitude: number
  /** Metres. */
  accuracyM: number
  label?: string
}

export type ChatMessage = {
  id: string
  /** 'me' or the sender's account id (hex); empty for notices. */
  from: string
  /** A notice from this app (e.g. a safety number change), not a message. */
  kind?: 'notice'
  /** Sender's display name (or username), resolved when read. */
  fromName?: string
  text: string
  sentAt: number
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received'
  /** Our messages: accounts that confirmed delivery or reading (FR-MSG-5). */
  deliveredTo?: string[]
  readBy?: string[]
  /** Received messages: this user has seen it (a read receipt was due). */
  seen?: boolean
  /** Why it wasn't sent ('failed' only). */
  error?: string
  /** An image or file; `text` is then its caption. */
  file?: FileInfo
  location?: LocationInfo
}

export type CoreStatus = { version: string; selfTest: boolean }
export type BenchResult = { members: number; setupMs: number; commitMs: number; commitBytes: number }

export type CoreRequest =
  | { type: 'view' }
  | { type: 'signUp'; username: string; displayName: string; invite?: string }
  | { type: 'createInvite' }
  | { type: 'startChat'; username: string }
  | { type: 'createGroup'; name: string; usernames: string[] }
  | { type: 'addMembers'; conversationId: string; usernames: string[] }
  | { type: 'members'; conversationId: string }
  | { type: 'pushKey' }
  | { type: 'enablePush'; subscription: PushSubscriptionJSON }
  | { type: 'renameGroup'; conversationId: string; name: string }
  | { type: 'makeAdmin'; conversationId: string; account: string }
  | { type: 'removeMember'; conversationId: string; account: string }
  | { type: 'leaveGroup'; conversationId: string }
  | { type: 'messages'; conversationId: string }
  | { type: 'sendText'; conversationId: string; text: string }
  | { type: 'sendLocation'; conversationId: string; location: LocationInfo }
  | { type: 'mapInfo' }
  | { type: 'tile'; z: number; x: number; y: number }
  | { type: 'sendFile'; conversationId: string; file: File; caption: string; media?: MediaInfo }
  | { type: 'openAttachment'; conversationId: string; messageId: string }
  | { type: 'startLink' }
  | { type: 'cancelLink' }
  | { type: 'approveLink'; text: string }
  | { type: 'devices' }
  | { type: 'removeDevice'; id: string }
  | { type: 'decodeQr'; rgba: Uint8Array; width: number; height: number }
  | { type: 'safetyNumber'; conversationId: string; account: string }
  | { type: 'markVerified'; conversationId: string; account: string }
  | { type: 'verifyScanned'; conversationId: string; account: string; text: string }
  | { type: 'dismissAlert'; id: string }
  | { type: 'acceptRequest'; conversationId: string }
  | { type: 'deleteAccount'; username: string }
  | { type: 'setupBackup' }
  | { type: 'backupNow' }
  | { type: 'turnOffBackup' }
  | { type: 'restore'; username: string; recoveryKey: string }
  | { type: 'markRead'; conversationId: string }
  | { type: 'retryMessage'; conversationId: string; messageId: string }
  | { type: 'setReadReceipts'; on: boolean }
  | { type: 'setMedia'; media: MediaSettings }
  | { type: 'block'; account: string }
  | { type: 'unblock'; account: string }
  | { type: 'blocked' }
  | {
      type: 'report'
      conversationId: string
      account: string
      reason: ReportReason
      includeMessages: boolean
    }
  | { type: 'status' }
  | { type: 'bench'; members: number }

export type CoreResponseBody =
  | { type: 'view'; view: AppView }
  | { type: 'ok' }
  | { type: 'conversation'; conversationId: string }
  | { type: 'messages'; messages: ChatMessage[] }
  | { type: 'file'; blob: Blob }
  | { type: 'mapInfo'; info: MapInfo }
  | { type: 'tile'; data?: Uint8Array<ArrayBuffer> }
  | { type: 'members'; members: MemberInfo[] }
  | { type: 'pushKey'; key: string }
  | { type: 'link'; offer: LinkOffer }
  | { type: 'invite'; offer: InviteOffer }
  | { type: 'recoveryKey'; key: string }
  | { type: 'devices'; devices: DeviceInfo[] }
  | { type: 'qr'; text?: string }
  | { type: 'safety'; safety: SafetyNumber }
  | { type: 'blocked'; contacts: BlockedContact[] }
  | { type: 'status'; status: CoreStatus }
  | { type: 'bench'; result: BenchResult }
  | { type: 'error'; message: string }

/** Pushed by the worker without a request. */
export type CoreEvent =
  | { type: 'view'; view: AppView }
  | { type: 'messages'; conversationId: string }
  /** An attachment upload or download moved on (ADR-0025). */
  | { type: 'progress'; conversationId: string; messageId: string; done: number; total: number }

export type RequestEnvelope = { id: number; request: CoreRequest }
/** `id` 0 carries an unsolicited event. */
export type ResponseEnvelope = { id: number; body: CoreResponseBody } | { id: 0; event: CoreEvent }

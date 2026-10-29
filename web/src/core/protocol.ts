// Messages between the UI thread and the core worker. The worker owns all
// keys, storage and network connections; the UI only renders `AppView`.

export type ConnectionState = 'offline' | 'connecting' | 'online'

export type ConversationSummary = {
  id: string
  title: string
  isGroup: boolean
  amAdmin: boolean
  /** 'left' / 'removed': read-only history. */
  status: 'active' | 'left' | 'removed'
  /** Including this user. */
  memberCount: number
  /** 1:1 chats: the other person's account id. */
  peer?: string
  /** From someone with no connection to this user, until accepted (FR-SAF-3). */
  request: boolean
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
      me: { phone: string; displayName: string }
      connection: ConnectionState
      conversations: ConversationSummary[]
      /** New devices on this account that nobody here approved (ADR-0020). */
      alerts: { id: string; text: string }[]
    }

/** One of this account's devices (ADR-0019). */
export type DeviceInfo = { id: string; addedOn: string; lastSeenOn?: string; current: boolean }

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

export type ChatMessage = {
  id: string
  /** 'me' or the sender's account id (hex); empty for notices. */
  from: string
  /** A notice from this app (e.g. a safety number change), not a message. */
  kind?: 'notice'
  /** Sender's display name (or phone), resolved when read. */
  fromName?: string
  text: string
  sentAt: number
  status: 'sending' | 'sent' | 'failed' | 'received'
}

export type CoreStatus = { version: string; selfTest: boolean }
export type BenchResult = { members: number; setupMs: number; commitMs: number; commitBytes: number }

export type CoreRequest =
  | { type: 'view' }
  | { type: 'requestCode'; phone: string }
  | { type: 'verify'; phone: string; code: string; displayName: string }
  | { type: 'startChat'; phone: string }
  | { type: 'createGroup'; name: string; phones: string[] }
  | { type: 'addMembers'; conversationId: string; phones: string[] }
  | { type: 'members'; conversationId: string }
  | { type: 'pushKey' }
  | { type: 'enablePush'; subscription: PushSubscriptionJSON }
  | { type: 'renameGroup'; conversationId: string; name: string }
  | { type: 'makeAdmin'; conversationId: string; account: string }
  | { type: 'removeMember'; conversationId: string; account: string }
  | { type: 'leaveGroup'; conversationId: string }
  | { type: 'messages'; conversationId: string }
  | { type: 'sendText'; conversationId: string; text: string }
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
  | { type: 'deleteAccount'; phone: string }
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
  | { type: 'members'; members: MemberInfo[] }
  | { type: 'pushKey'; key: string }
  | { type: 'link'; offer: LinkOffer }
  | { type: 'devices'; devices: DeviceInfo[] }
  | { type: 'qr'; text?: string }
  | { type: 'safety'; safety: SafetyNumber }
  | { type: 'blocked'; contacts: BlockedContact[] }
  | { type: 'status'; status: CoreStatus }
  | { type: 'bench'; result: BenchResult }
  | { type: 'error'; message: string }

/** Pushed by the worker without a request. */
export type CoreEvent = { type: 'view'; view: AppView } | { type: 'messages'; conversationId: string }

export type RequestEnvelope = { id: number; request: CoreRequest }
/** `id` 0 carries an unsolicited event. */
export type ResponseEnvelope = { id: number; body: CoreResponseBody } | { id: 0; event: CoreEvent }

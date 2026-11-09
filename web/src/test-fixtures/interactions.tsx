// Browser-only UI fixture. No worker, encryption, storage, or server transport.
import { createRoot } from 'react-dom/client'
import { Chat } from '../ui/Chat'
import { canEncryptCalls, type CoreClient } from '../core/client'
import type { AppView, ChatMessage, Draft, StorageUsage } from '../core/protocol'
import { TypingLeases, TYPING_TTL_MS } from '../core/typing'
import '../styles.css'

const params = new URLSearchParams(location.search)
const name = params.get('name') ?? 'Alice'
const remote = name === 'Alice' ? 'Bob' : 'Alice'
const isGroup = params.get('group') === '1'
const title = params.get('title') ?? remote
const room = params.get('room') ?? 'fixture'
const channel = new BroadcastChannel(`interaction-fixture-${room}`)
const subscribers = new Set<(event: unknown) => void>()
let stored: ChatMessage[] = []
let failMessages = false
let holdMessages = false
let staleHistory: ChatMessage[] | undefined
let releaseMessages: (() => void) | undefined
let rejectMessages: ((error: Error) => void) | undefined
let failAttachment = false
let holdAttachment = false
let releaseAttachment: (() => void) | undefined
let failDeletion = false
let failDeletionAcceptance = false
const hiddenMessages = new Set<string>()
const deletionRequests: { id: string; scope: 'me' | 'everyone' }[] = []
const qualityActivity = { historyLoads: 0, attachmentOpens: 0 }
let dropTypingStops = false
let holdNextSend = false
let rejectPendingSend: ((error: Error) => void) | undefined
let acceptPendingSend: (() => void) | undefined
// Retained fake worker records survive restartUI(), not a page/process restart.
// Production durability is covered by worker/storage tests, not browser storage.
const draftRecords = new Map<string, Draft>()
const attachmentCaptions: { id: string; text: string; name: string; revision?: number }[] = []
const draftRecord = (id: string) => ({ ...(draftRecords.get(id) ?? { text: '', revision: 0 }) })
let failDraftLoad = false
let failDraftSave = false
let conflictDraftSave = false
let holdDraftLoad = false
let releaseDraftLoad: (() => void) | undefined
let holdDraftSave = false
let releaseDraftSave: (() => void) | undefined
let fixtureSession = 0
let rejectMapInfo: ((error: Error) => void) | undefined
// Control the fake worker response, never an HTTP response or UI fetch.
let storageRequests = 0
let pendingStorage: { resolve: (usage: StorageUsage) => void; reject: (error: Error) => void } | undefined
const callActions: string[] = []
const liveActivity = { updates: 0, pauses: 0, stops: [] as string[] }
const liveStarts: { conversationId: string; durationMs: number | null; location: { latitude: number; longitude: number; accuracyM: number } }[] = []
const leases = new TypingLeases()
let lastTyping = ''
const typists = () => leases.accounts(Date.now(), () => true).map((account) => ({ account, name: account }))
const publishTyping = () => {
  const next = typists()
  const key = JSON.stringify(next)
  if (key === lastTyping) return
  lastTyping = key
  emit({ type: 'typing', conversationId: 'chat', typists: next })
}
setInterval(publishTyping, 100)
const emit = (event: unknown) => subscribers.forEach((listener) => listener(event))
const refresh = () => emit({ type: 'messages', conversationId: 'chat' })
const resolveMessages = () => stored.filter((message) => !hiddenMessages.has(message.id)).map((storedMessage) => {
  const deletion = params.get('deletion') === '1'
  const deadline = storedMessage.deleteForEveryoneUntil ?? storedMessage.sentAt + 3_600_000
  const message = { ...storedMessage, canReact: !storedMessage.deleted && params.get('reactions') === '1' && storedMessage.canReply === true,
    canDeleteForMe: deletion,
    deleteForMeLocalOnly: storedMessage.deleteForMeLocalOnly !== false,
    canDeleteForEveryone: deletion && !storedMessage.deleted && storedMessage.from === 'me' && storedMessage.canDeleteForEveryone === true && Date.now() <= deadline,
    deleteForEveryoneUntil: deletion ? deadline : undefined }
  if (message.deleted) return { ...message, text: '', file: undefined, live: undefined, location: undefined, reply: undefined, reactions: undefined, canReply: false, canReact: false }
  if (!message.replyTo) return message
  const original = stored.find((m) => m.id === message.replyTo && !m.deleted && !hiddenMessages.has(m.id))
  return { ...message, reply: original
    ? { messageId: original.id, from: original.from, fromName: original.fromName, text: original.text }
    : { messageId: message.replyTo, text: 'Original message unavailable', unavailable: true } }
})
const receive = (data: { type: string; message?: ChatMessage; active?: boolean }) => {
  if (data.type === 'message' && data.message) {
    stored.push({ ...data.message, from: remote, fromName: remote, status: 'received' })
    refresh()
  } else if (data.type === 'typing') {
    if (!data.active && dropTypingStops) return
    const now = Date.now()
    leases.update(`${remote}-device`, remote, !!data.active, now, now + TYPING_TTL_MS, now)
    publishTyping()
  }
}
channel.onmessage = ({ data }) => receive(data)
const core = {
  subscribe: (listener: (event: unknown) => void) => { subscribers.add(listener); return () => subscribers.delete(listener) },
  messages: async (id: string) => {
    qualityActivity.historyLoads++
    if (failMessages) throw new Error('Fixture history is temporarily unavailable')
    const messages = id === 'chat' ? staleHistory ?? resolveMessages() : []
    staleHistory = undefined
    if (holdMessages) {
      holdMessages = false
      await new Promise<void>((resolve, reject) => { releaseMessages = resolve; rejectMessages = reject })
    }
    return messages
  },
  openAttachment: async () => {
    qualityActivity.attachmentOpens++
    if (holdAttachment) {
      holdAttachment = false
      await new Promise<void>((resolve) => { releaseAttachment = resolve })
    }
    if (failAttachment) throw new Error('Fixture attachment is temporarily unavailable')
    return new Blob(['Local fixture bytes'], { type: 'text/plain' })
  },
  storageUsage: () => {
    storageRequests++
    return new Promise<StorageUsage>((resolve, reject) => { pendingStorage = { resolve, reject } })
  },
  getDraft: async (id: string) => {
    if (failDraftLoad) throw new Error('Fixture draft load failed')
    const draft = draftRecord(id)
    if (holdDraftLoad) {
      holdDraftLoad = false
      await new Promise<void>((resolve) => { releaseDraftLoad = resolve })
    }
    return draft
  },
  saveDraft: async (id: string, text: string, expectedRevision: number) => {
    if (holdDraftSave) {
      holdDraftSave = false
      await new Promise<void>((resolve) => { releaseDraftSave = resolve })
    }
    if (failDraftSave) throw new Error('Fixture draft save failed')
    if (conflictDraftSave) {
      conflictDraftSave = false
      draftRecords.set(id, { text: 'Other saved text', revision: draftRecord(id).revision + 1 })
    }
    const previous = draftRecord(id)
    if (expectedRevision !== previous.revision) return { applied: false, draft: previous }
    const draft = { text, revision: expectedRevision + 1 }
    draftRecords.set(id, draft)
    return { applied: true, draft }
  },
  deleteMessage: async (_id: string, messageId: string, scope: 'me' | 'everyone') => {
    if (failDeletionAcceptance) throw new Error('Fixture tombstone storage failed')
    const message = stored.find((message) => message.id === messageId)
    if (!message) throw new Error('Missing message')
    if (scope === 'everyone' && (message.deleted || message.from !== 'me' || message.canDeleteForEveryone !== true || Date.now() > (message.deleteForEveryoneUntil ?? message.sentAt + 3_600_000))) throw new Error('Deletion window or authorization changed')
    deletionRequests.push({ id: messageId, scope })
    if (message.live && message.from === 'me') {
      liveActivity.stops.push(_id)
      view.liveSharing = view.liveSharing.filter((share) => share.conversationId !== _id)
      renderFixture()
    }
    if (scope === 'me') hiddenMessages.add(messageId)
    else {
      message.deleted = true
      message.deletionStatus = { id: `delete-${messageId}`, status: failDeletion ? 'failed' : 'sending', ...(failDeletion ? { error: 'Fixture delivery refused' } : {}) }
    }
    refresh()
    return { accepted: true as const, scope }
  },
  retryDeletion: async (_id: string, eventId: string) => {
    const message = stored.find((message) => message.deletionStatus?.id === eventId)
    if (!message) throw new Error('Missing accepted deletion')
    message.deletionStatus = { id: eventId, status: 'sending' }
    refresh()
    return { accepted: true as const, scope: 'everyone' as const }
  },
  react: async (_id: string, targetId: string, emoji: string) => {
    const message = stored.find((m) => m.id === targetId)
    if (!message) throw new Error('Missing fixture message')
    const own = message.reactions?.find((r) => r.own)
    const next = own?.emoji === emoji ? '' : emoji
    message.reactions = (message.reactions ?? []).map((r) => ({ ...r, count: r.count - (r.own ? 1 : 0), own: false })).filter((r) => r.count > 0)
    if (next) {
      const existing = message.reactions.find((r) => r.emoji === next)
      if (existing) { existing.count++; existing.own = true }
      else message.reactions.push({ emoji: next, count: 1, own: true })
    }
    refresh()
  },
  retryMessage: async (_id: string, messageId: string) => {
    const message = stored.find((m) => m.reactionStatus?.id === messageId)
    if (message?.reactionStatus) message.reactionStatus = { id: messageId, status: 'sending' }
    refresh()
  },
  markRead: async () => {},
  typing: async () => typists(),
  setTypingIndicators: async (on: boolean) => { view.typingIndicators = on; renderFixture() },
  avatar: async () => undefined,
  members: async () => [
    { account: name, name, isMe: true, isAdmin: true, blocked: false },
    { account: remote, name: remote, isMe: false, isAdmin: false, blocked: false },
  ],
  groupCallStatus: async () => undefined,
  // Keep fixture calls at setup. These tests make no media or transport claim.
  iceServers: () => { callActions.push('answer'); return new Promise(() => {}) },
  callSignal: (_id: string, signal: { kind: string }) => {
    callActions.push(signal.kind)
    return signal.kind === 'offer' ? new Promise(() => {}) : Promise.resolve()
  },
  groupCallJoin: () => { callActions.push('join'); return new Promise(() => {}) },
  recordCall: () => {},
  avatarPhoto: async () => undefined,
  pushStatus: async () => ({ enabled: false }),
  mapInfo: () => new Promise((_resolve, reject) => {
    rejectMapInfo = reject
    document.documentElement.dataset.mapStylePending = 'true'
  }),
  startLive: async (conversationId: string, durationMs: number | null, location: { latitude: number; longitude: number; accuracyM: number }) => {
    liveStarts.push({ conversationId, durationMs, location })
  },
  liveUpdate: async () => { liveActivity.updates++ },
  pauseLive: async () => { liveActivity.pauses++ },
  stopLive: async (id: string) => {
    liveActivity.stops.push(id)
    view.liveSharing = view.liveSharing.filter((share) => share.conversationId !== id)
    if (id === 'chat') stored = stored.map((message) => message.live && message.from === 'me'
      ? { ...message, live: { ...message.live, stopped: true, ended: true } } : message)
    refresh()
    renderFixture()
  },
  setTyping: async (_id: string, active: boolean) => channel.postMessage({ type: 'typing', active }),
  sendFile: async (id: string, file: File, caption: string, _media: unknown, draftRevision?: number) => {
    attachmentCaptions.push({ id, text: caption, name: file.name, revision: draftRevision })
    // Model local acceptance and caption fencing, not media storage or upload.
    return core.sendText(id, caption, undefined, draftRevision)
  },
  sendText: async (id: string, text: string, replyTo?: string, draftRevision?: number) => {
    if (holdNextSend) {
      holdNextSend = false
      await new Promise<void>((resolve, reject) => { acceptPendingSend = resolve; rejectPendingSend = reject })
    }
    const message: ChatMessage = { id: crypto.randomUUID(), from: 'me', text, replyTo, sentAt: Date.now(), status: 'sent', canReply: true, canDeleteForEveryone: true, deleteForMeLocalOnly: false }
    stored.push(message)
    refresh()
    channel.postMessage({ type: 'message', message })
    const previous = draftRecord(id)
    let consumedRevision: number | undefined
    if (previous.revision === draftRevision && previous.text.trim() === text) {
      consumedRevision = previous.revision + 1
      draftRecords.set(id, { text: '', revision: consumedRevision })
    }
    return { draft: draftRecord(id), consumedRevision }
  },
} as unknown as CoreClient
const view: Extract<AppView, { phase: 'ready' }> = {
  phase: 'ready', me: { account: name, username: name, displayName: name }, connection: 'online',
  conversations: [{ id: 'chat', title, isGroup, amAdmin: isGroup, status: 'active', memberCount: 2, peer: isGroup ? undefined : remote, request: false, unread: 0, lastAt: Date.now() }],
  alerts: [], readReceipts: true, typingIndicators: true, relayCalls: true, callStats: false,
  media: { photos: 'never', audio: 'never', video: 'never', files: 'never', quality: 'standard' }, liveSharing: [],
}
Object.assign(window, {
  interactionFixture: {
    liveStarts,
    liveActivity,
    callActions,
    storageRequests() { return storageRequests },
    storagePending() { return !!pendingStorage },
    resolveStorage(usage: StorageUsage) {
      const pending = pendingStorage
      pendingStorage = undefined
      pending?.resolve(usage)
    },
    rejectStorage() {
      const pending = pendingStorage
      pendingStorage = undefined
      pending?.reject(new Error('Fixture storage request failed'))
    },
    attachmentCaptions,
    canEncryptCalls,
    qualityActivity,
    deletionRequests,
    failDeletion(value: number) { failDeletion = value === 1 },
    failDeletionAcceptance(value: number) { failDeletionAcceptance = value === 1 },
    holdAttachment() { holdAttachment = true },
    attachmentPending() { return !!releaseAttachment },
    releaseAttachment() { releaseAttachment?.(); releaseAttachment = undefined },
    requestChat() { view.conversations[0].request = true; renderFixture() },
    ownDeletionMessage(options: { legacy?: boolean; noReply?: boolean; deadline?: number; pending?: boolean; media?: boolean; video?: boolean; photo?: boolean; location?: boolean } = {}) {
      const message: ChatMessage = { id: crypto.randomUUID(), from: 'me', text: 'Own deletion target', sentAt: Date.now(), status: options.pending ? 'sending' : 'sent', canReply: !options.legacy && !options.noReply, canDeleteForEveryone: !options.legacy, deleteForMeLocalOnly: !!options.legacy, deleteForEveryoneUntil: options.deadline }
      if (options.media) message.file = { name: 'secret.txt', mime: 'text/plain', size: 19 }
      if (options.video) message.file = { name: 'secret.webm', mime: 'video/webm', size: 19 }
      if (options.photo) message.file = { name: 'secret.jpg', mime: 'image/jpeg', size: 19 }
      if (options.location) message.location = { latitude: 48.8584, longitude: 2.2945, accuracyM: 12, label: 'Private meeting point' }
      stored.push(message)
      refresh()
    },
    deleteIncoming() { if (stored[0]) stored[0].deleted = true; refresh() },
    remoteDeletion(options: { scope: 'me' | 'everyone'; mode: 'hold' | 'fail' }) {
      const message = stored[0]
      if (!message) throw new Error('No fixture original')
      if (options.mode === 'hold') { staleHistory = resolveMessages(); holdMessages = true }
      else failMessages = true
      if (options.scope === 'me') hiddenMessages.add(message.id)
      else message.deleted = true
      emit({ type: 'messages', conversationId: 'chat', deletions: [{ messageId: message.id, scope: options.scope }] })
    },
    failMessages(value: number) { failMessages = value === 1 },
    holdMessages() { holdMessages = true },
    holdStaleHistory() { staleHistory = resolveMessages(); holdMessages = true },
    refreshHistory() { refresh() },
    historyPending() { return !!releaseMessages },
    releaseMessages(reject?: number) {
      if (reject === 1) rejectMessages?.(new Error('Late fixture history failure'))
      else releaseMessages?.()
      releaseMessages = undefined
      rejectMessages = undefined
    },
    failAttachment(value: number) { failAttachment = value === 1 },
    sampleAttachment(filename: string) {
      stored.push({ id: crypto.randomUUID(), from: remote, text: '', sentAt: Date.now(), status: 'received', canReply: true, deleteForMeLocalOnly: false,
        file: { name: filename, mime: 'text/plain', size: 19 } })
      refresh()
    },
    connection(value: 'online' | 'offline' | 'connecting') { view.connection = value; renderFixture() },
    incomingCall(group: boolean) {
      emit({ type: 'call', signal: {
        conversationId: 'chat', callId: crypto.randomUUID().replaceAll('-', ''),
        fromDevice: 'remote-device', title, kind: 'offer', sdp: 'UI fixture offer', video: false, group,
      } })
    },
    failMap() {
      rejectMapInfo?.(new Error('Delayed map style failure from fixture'))
      rejectMapInfo = undefined
    },
    activeLiveShare(expired?: number) {
      const now = Date.now()
      const untilStopped = expired === 1
      const expiresAt = now + (untilStopped ? -60_000 : 15 * 60_000)
      view.liveSharing = [{ conversationId: 'chat', title, expiresAt, untilStopped }]
      stored.push({
        id: crypto.randomUUID(), from: 'me', text: '', sentAt: now, status: 'sent', canReply: true, canDeleteForEveryone: true, deleteForMeLocalOnly: false,
        live: { sessionId: crypto.randomUUID(), expiresAt, untilStopped, ended: false, latest: { latitude: 48.8584, longitude: 2.2945, accuracyM: 12, at: now } },
      })
      refresh()
      renderFixture()
    },
    dropTypingStops(value: number) { dropTypingStops = value === 1 },
    holdNextSend() { holdNextSend = true },
    acceptSend() { acceptPendingSend?.(); acceptPendingSend = undefined; rejectPendingSend = undefined },
    pendingSend() { return !!rejectPendingSend },
    draft(id = 'chat') { return draftRecord(id) },
    seedDraft(text: string) { draftRecords.set('chat', { text, revision: draftRecord('chat').revision + 1 }) },
    failDraftLoad(value: number) { failDraftLoad = value === 1 },
    failDraftSave(value: number) { failDraftSave = value === 1 },
    conflictDraftSave() { conflictDraftSave = true },
    holdDraftLoad() { holdDraftLoad = true },
    draftLoadPending() { return !!releaseDraftLoad },
    draftSavePending() { return !!releaseDraftSave },
    releaseDraftLoad() { releaseDraftLoad?.(); releaseDraftLoad = undefined },
    holdDraftSave() { holdDraftSave = true },
    releaseDraftSave() { releaseDraftSave?.(); releaseDraftSave = undefined },
    restartUI() { fixtureSession++; renderFixture() },
    addChat() {
      if (!view.conversations.some((conversation) => conversation.id === 'other')) {
        view.conversations.push({ ...view.conversations[0], id: 'other', title: 'Other chat', peer: 'Other' })
        renderFixture()
      }
    },
    rejectSend() { rejectPendingSend?.(new Error('Fixture send failed')); rejectPendingSend = undefined },
    seed(count: number) {
      stored = Array.from({ length: count }, (_, i) => ({ id: `history-${i}`, from: remote, fromName: remote, text: `History ${i}`, sentAt: Date.now() - (count - i) * 1000, status: 'received' as const, canReply: true, deleteForMeLocalOnly: false }))
      refresh()
    },
    incoming(text: string) {
      receive({ type: 'message', message: { id: crypto.randomUUID(), from: remote, text, sentAt: Date.now(), status: 'received', canReply: true, deleteForMeLocalOnly: false } })
    },
    legacyMessage(value?: number) {
      receive({ type: 'message', message: { id: crypto.randomUUID(), from: remote, text: 'Legacy message without verification data', sentAt: Date.now(), status: 'received', canReply: value === 1 ? undefined : false, deleteForMeLocalOnly: true } })
    },
    makeReplyAvailable() {
      // Simulate eligibility changing after worker encryption, not UI verification.
      const message = stored.find((message) => message.canReply === false)
      if (message) message.canReply = true
      refresh()
    },
    blockRenamedDirect() {
      view.conversations[0].title = 'Renamed direct chat'
      view.conversations[0].blocked = true
      renderFixture()
    },
    failReaction() {
      if (stored[0]) stored[0].reactionStatus = { id: 'failed-reaction', status: 'failed', error: 'The server refused this message' }
      refresh()
    },
    acceptReaction() {
      if (stored[0]) stored[0].reactionStatus = undefined
      refresh()
    },
    loseReactionEligibility() {
      if (stored[0]) stored[0].canReply = false
      refresh()
    },
    seedReactions() {
      const message = stored[0]
      if (message) message.reactions = [{ emoji: '👍', count: 2, own: false }]
      refresh()
    },
    missingReply() {
      stored.push({ id: 'missing-reply', from: remote, fromName: remote, text: 'Reply without local original', replyTo: 'not-on-this-device', sentAt: Date.now(), status: 'received', canReply: true, deleteForMeLocalOnly: false })
      refresh()
    },
  },
})
window.addEventListener('error', (event) => {
  const error = document.createElement('pre')
  error.dataset.testid = 'fixture-error'
  error.textContent = event.message
  document.body.append(error)
})
const fixtureRoot = createRoot(document.getElementById('root')!)
function renderFixture() {
  fixtureRoot.render(<Chat key={fixtureSession} core={core} view={{ ...view }} showDiagnostics={false} onDiagnostics={() => {}} />)
}
renderFixture()

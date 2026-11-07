// Browser-only UI fixture. No worker, encryption, storage, or server transport.
import { createRoot } from 'react-dom/client'
import { Chat } from '../ui/Chat'
import { canEncryptCalls, type CoreClient } from '../core/client'
import type { AppView, ChatMessage } from '../core/protocol'
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
let dropTypingStops = false
let holdNextSend = false
let rejectPendingSend: ((error: Error) => void) | undefined
let rejectMapInfo: ((error: Error) => void) | undefined
const callActions: string[] = []
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
const resolveMessages = () => stored.map((message) => {
  if (!message.replyTo) return message
  const original = stored.find((m) => m.id === message.replyTo)
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
  messages: async () => resolveMessages(),
  markRead: async () => {},
  typing: async () => typists(),
  setTypingIndicators: async () => {},
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
  setTyping: async (_id: string, active: boolean) => channel.postMessage({ type: 'typing', active }),
  sendText: async (_id: string, text: string, replyTo?: string) => {
    if (holdNextSend) {
      holdNextSend = false
      await new Promise<void>((_resolve, reject) => { rejectPendingSend = reject })
    }
    const message: ChatMessage = { id: crypto.randomUUID(), from: 'me', text, replyTo, sentAt: Date.now(), status: 'sent' }
    stored.push(message)
    refresh()
    channel.postMessage({ type: 'message', message })
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
    callActions,
    canEncryptCalls,
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
    dropTypingStops(value: number) { dropTypingStops = value === 1 },
    holdNextSend() { holdNextSend = true },
    rejectSend() { rejectPendingSend?.(new Error('Fixture send failed')); rejectPendingSend = undefined },
    seed(count: number) {
      stored = Array.from({ length: count }, (_, i) => ({ id: `history-${i}`, from: remote, fromName: remote, text: `History ${i}`, sentAt: Date.now() - (count - i) * 1000, status: 'received' as const }))
      refresh()
    },
    incoming(text: string) {
      receive({ type: 'message', message: { id: crypto.randomUUID(), from: remote, text, sentAt: Date.now(), status: 'received' } })
    },
    missingReply() {
      stored.push({ id: 'missing-reply', from: remote, fromName: remote, text: 'Reply without local original', replyTo: 'not-on-this-device', sentAt: Date.now(), status: 'received' })
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
createRoot(document.getElementById('root')!).render(<Chat core={core} view={view} showDiagnostics={false} onDiagnostics={() => {}} />)

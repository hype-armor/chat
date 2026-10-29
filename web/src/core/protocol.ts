// Messages between the UI thread and the core worker. The worker owns all
// keys, storage and network connections; the UI only renders `AppView`.

export type ConnectionState = 'offline' | 'connecting' | 'online'

export type ConversationSummary = {
  id: string
  title: string
  lastText?: string
  lastAt: number
}

export type AppView =
  | { phase: 'loading' }
  | { phase: 'signed-out' }
  | {
      phase: 'ready'
      me: { phone: string; displayName: string }
      connection: ConnectionState
      conversations: ConversationSummary[]
    }

export type ChatMessage = {
  id: string
  /** 'me' or the sender's account id (hex). */
  from: string
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
  | { type: 'messages'; conversationId: string }
  | { type: 'sendText'; conversationId: string; text: string }
  | { type: 'status' }
  | { type: 'bench'; members: number }

export type CoreResponseBody =
  | { type: 'view'; view: AppView }
  | { type: 'ok' }
  | { type: 'conversation'; conversationId: string }
  | { type: 'messages'; messages: ChatMessage[] }
  | { type: 'status'; status: CoreStatus }
  | { type: 'bench'; result: BenchResult }
  | { type: 'error'; message: string }

/** Pushed by the worker without a request. */
export type CoreEvent = { type: 'view'; view: AppView } | { type: 'messages'; conversationId: string }

export type RequestEnvelope = { id: number; request: CoreRequest }
/** `id` 0 carries an unsolicited event. */
export type ResponseEnvelope = { id: number; body: CoreResponseBody } | { id: 0; event: CoreEvent }

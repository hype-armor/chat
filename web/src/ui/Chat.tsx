import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { AppView, ChatMessage } from '../core/protocol'

type Ready = Extract<AppView, { phase: 'ready' }>

const STATUS_LABEL: Record<ChatMessage['status'], string> = {
  sending: 'Sending…',
  sent: 'Sent',
  failed: 'Not sent',
  received: '',
}

export function Chat({ core, view }: { core: CoreClient; view: Ready }) {
  const [selected, setSelected] = useState<string>()
  const conversation = view.conversations.find((c) => c.id === selected)

  return (
    <div className={`chat-layout ${conversation ? 'has-selection' : ''}`}>
      <aside className="sidebar">
        <header className="bar">
          <div>
            <strong>{view.me.displayName}</strong>
            <div className="muted small">{view.me.phone}</div>
          </div>
          <span className={`connection ${view.connection}`} role="status">
            {view.connection}
          </span>
        </header>
        <NewChat core={core} onStarted={setSelected} />
        <nav aria-label="Conversations">
          <ul className="conversations">
            {view.conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={c.id === selected ? 'active' : ''}
                  onClick={() => setSelected(c.id)}
                >
                  <span className="title">{c.title}</span>
                  <span className="muted small preview">{c.lastText ?? 'No messages yet'}</span>
                </button>
              </li>
            ))}
          </ul>
          {view.conversations.length === 0 && <p className="muted empty">No conversations yet.</p>}
        </nav>
      </aside>
      {conversation ? (
        <Conversation
          core={core}
          id={conversation.id}
          title={conversation.title}
          onBack={() => setSelected(undefined)}
        />
      ) : (
        <section className="placeholder muted">Select a conversation or start a new one.</section>
      )}
    </div>
  )
}

function NewChat({ core, onStarted }: { core: CoreClient; onStarted: (id: string) => void }) {
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      onStarted(await core.startChat(phone.trim()))
      setPhone('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="new-chat" onSubmit={submit}>
      <label>
        Contact's phone number
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          type="tel"
          required
          placeholder="+15551234567"
          pattern="\+[1-9][0-9]{7,14}"
        />
      </label>
      <button type="submit" disabled={busy}>
        Start chat
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  )
}

function Conversation({ core, id, title, onBack }: { core: CoreClient; id: string; title: string; onBack: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    const load = () => core.messages(id).then((m) => live && setMessages(m))
    load()
    const unsubscribe = core.subscribe((e) => {
      if (e.type === 'messages' && e.conversationId === id) load()
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [core, id])

  useEffect(() => {
    // Block body: scrollIntoView may return a Promise, which React would
    // mistake for an effect cleanup function.
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    await core.sendText(id, text)
  }

  return (
    <section className="conversation" aria-label={`Conversation with ${title}`}>
      <header className="bar">
        <button type="button" className="link back" onClick={onBack} aria-label="Back to conversations">
          ←
        </button>
        <h2>{title}</h2>
      </header>
      <ol className="messages">
        {messages.map((m) => (
          <li key={m.id} className={m.from === 'me' ? 'mine' : 'theirs'} data-testid="message">
            <span className="text">{m.text}</span>
            <span className="meta small">
              {new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {STATUS_LABEL[m.status] && ` · ${STATUS_LABEL[m.status]}`}
            </span>
          </li>
        ))}
      </ol>
      <div ref={end} />
      <form className="composer" onSubmit={send}>
        <label className="visually-hidden" htmlFor="composer">
          Message
        </label>
        <input
          id="composer"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message"
          autoComplete="off"
          maxLength={4000}
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </section>
  )
}

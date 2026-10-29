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
        <NewGroup core={core} onCreated={setSelected} />
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
          isGroup={conversation.isGroup}
          memberCount={conversation.memberCount}
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
  const { busy, error, run } = useAction()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      onStarted(await core.startChat(phone.trim()))
      setPhone('')
    })
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

/** Splits a free-form list of phone numbers (commas, spaces or new lines). */
export function parsePhones(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean)
}

/** Runs an async action with busy and error state for a form. */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function NewGroup({ core, onCreated }: { core: CoreClient; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [phones, setPhones] = useState('')
  const { busy, error, run } = useAction()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      onCreated(await core.createGroup(name, parsePhones(phones)))
      setName('')
      setPhones('')
    })
  }

  return (
    <details className="new-group">
      <summary>New group</summary>
      <form onSubmit={submit}>
        <label>
          Group name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
        </label>
        <label>
          Members' phone numbers
          <textarea
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
            required
            rows={3}
            placeholder={'+15551234567\n+15557654321'}
          />
        </label>
        <button type="submit" disabled={busy}>
          Create group
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
    </details>
  )
}

function AddPeople({ core, id, onDone }: { core: CoreClient; id: string; onDone: () => void }) {
  const [phones, setPhones] = useState('')
  const { busy, error, run } = useAction()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      await core.addMembers(id, parsePhones(phones))
      setPhones('')
      onDone()
    })
  }

  return (
    <form className="add-people" onSubmit={submit}>
      <label>
        Phone numbers to add
        <input value={phones} onChange={(e) => setPhones(e.target.value)} required placeholder="+15551234567" />
      </label>
      <button type="submit" disabled={busy}>
        Add
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  )
}

function Conversation({
  core,
  id,
  title,
  isGroup,
  memberCount,
  onBack,
}: {
  core: CoreClient
  id: string
  title: string
  isGroup: boolean
  memberCount: number
  onBack: () => void
}) {
  const [adding, setAdding] = useState(false)
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
        {isGroup && <span className="muted small">{memberCount} people</span>}
        <button type="button" className="link" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add people'}
        </button>
      </header>
      {adding && <AddPeople core={core} id={id} onDone={() => setAdding(false)} />}
      <ol className="messages">
        {messages.map((m) => (
          <li key={m.id} className={m.from === 'me' ? 'mine' : 'theirs'} data-testid="message">
            {isGroup && m.from !== 'me' && <span className="sender small">{m.fromName}</span>}
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

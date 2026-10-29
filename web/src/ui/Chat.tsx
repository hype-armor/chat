import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { AppView, ChatMessage, ConversationSummary, MemberInfo } from '../core/protocol'

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
          amAdmin={conversation.amAdmin}
          status={conversation.status}
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

function GroupInfo({
  core,
  id,
  title,
  amAdmin,
  active,
}: {
  core: CoreClient
  id: string
  title: string
  amAdmin: boolean
  active: boolean
}) {
  const [members, setMembers] = useState<MemberInfo[]>([])
  const [name, setName] = useState(title)
  const { busy, error, run } = useAction()

  useEffect(() => {
    let live = true
    const load = () => core.members(id).then((m) => live && setMembers(m))
    load()
    const unsubscribe = core.subscribe((e) => e.type === 'view' && load())
    return () => {
      live = false
      unsubscribe()
    }
  }, [core, id])

  return (
    <section className="group-info" aria-label="Group info">
      {amAdmin && (
        <form
          className="rename"
          onSubmit={(e) => {
            e.preventDefault()
            run(() => core.renameGroup(id, name))
          }}
        >
          <label>
            Group name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
          </label>
          <button type="submit" disabled={busy}>
            Rename
          </button>
        </form>
      )}
      <ul className="members" aria-label="Members">
        {members.map((m) => (
          <li key={m.account}>
            <span>
              {m.isMe ? `${m.name} (you)` : m.name}
              {m.isAdmin && <span className="badge small">Admin</span>}
            </span>
            {amAdmin && !m.isMe && (
              <span className="actions">
                {!m.isAdmin && (
                  <button type="button" className="link small" disabled={busy} onClick={() => run(() => core.makeAdmin(id, m.account))}>
                    Make admin
                  </button>
                )}
                <button
                  type="button"
                  className="link small danger"
                  disabled={busy}
                  onClick={() => run(() => core.removeMember(id, m.account))}
                  aria-label={`Remove ${m.name}`}
                >
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {active && (
        <button type="button" className="link danger" disabled={busy} onClick={() => run(() => core.leaveGroup(id))}>
          Leave group
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
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
  amAdmin,
  status,
  onBack,
}: {
  core: CoreClient
  id: string
  title: string
  isGroup: boolean
  memberCount: number
  amAdmin: boolean
  status: ConversationSummary['status']
  onBack: () => void
}) {
  const [panel, setPanel] = useState<'add' | 'info'>()
  const active = status === 'active'
  const toggle = (p: 'add' | 'info') => setPanel((current) => (current === p ? undefined : p))
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
        {active && (
          <button type="button" className="link" onClick={() => toggle('add')}>
            {panel === 'add' ? 'Cancel' : 'Add people'}
          </button>
        )}
        {isGroup && (
          <button type="button" className="link" onClick={() => toggle('info')}>
            {panel === 'info' ? 'Close' : 'Group info'}
          </button>
        )}
      </header>
      {panel === 'add' && active && <AddPeople core={core} id={id} onDone={() => setPanel(undefined)} />}
      {panel === 'info' && <GroupInfo core={core} id={id} title={title} amAdmin={amAdmin && active} active={active} />}
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
      {!active && (
        <p className="notice" role="note">
          {status === 'left' ? 'You left this group.' : 'You were removed from this group.'}
        </p>
      )}
      <form className="composer" onSubmit={send} hidden={!active}>
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

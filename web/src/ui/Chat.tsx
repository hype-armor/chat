import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { AppView, ChatMessage, ConversationSummary, MemberInfo } from '../core/protocol'
import { Devices } from './Devices'
import { BlockedList, DeleteAccount, ReportForm } from './Safety'
import { VerificationBadge, Verify } from './Verify'
import { type NotificationState, enableNotifications, notificationState, refreshSubscription } from '../notifications'

type Ready = Extract<AppView, { phase: 'ready' }>

const STATUS_LABEL: Record<ChatMessage['status'], string> = {
  sending: 'Sending…',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Not sent',
  received: '',
}

export function Chat({ core, view }: { core: CoreClient; view: Ready }) {
  const [selected, setSelected] = useState<string>()
  const conversation = view.conversations.find((c) => c.id === selected)
  const requests = view.conversations.filter((c) => c.request)
  const accepted = view.conversations.filter((c) => !c.request)

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
        {view.alerts.map((a) => (
          <div key={a.id} className="alert" role="alert">
            <p>{a.text}</p>
            <button type="button" className="link small" onClick={() => void core.dismissAlert(a.id)}>
              Dismiss
            </button>
          </div>
        ))}
        <NotificationToggle core={core} />
        <Devices core={core} />
        <Privacy core={core} readReceipts={view.readReceipts} />
        <BlockedList core={core} />
        <DeleteAccount core={core} />
        <NewChat core={core} onStarted={setSelected} />
        <NewGroup core={core} onCreated={setSelected} />
        {requests.length > 0 && (
          <nav aria-label="Requests">
            <h3 className="list-heading small">Message requests</h3>
            <ConversationList conversations={requests} selected={selected} onSelect={setSelected} />
          </nav>
        )}
        <nav aria-label="Conversations">
          <ConversationList conversations={accepted} selected={selected} onSelect={setSelected} />
          {accepted.length === 0 && <p className="muted empty">No conversations yet.</p>}
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
          peer={conversation.peer}
          verification={conversation.verification}
          blocked={conversation.blocked ?? false}
          request={conversation.request}
          onBack={() => setSelected(undefined)}
        />
      ) : (
        <section className="placeholder muted">Select a conversation or start a new one.</section>
      )}
    </div>
  )
}

function ConversationList({
  conversations,
  selected,
  onSelect,
}: {
  conversations: ConversationSummary[]
  selected?: string
  onSelect: (id: string) => void
}) {
  return (
    <ul className="conversations">
      {conversations.map((c) => (
        <li key={c.id}>
          <button type="button" className={c.id === selected ? 'active' : ''} onClick={() => onSelect(c.id)}>
            <span className="title">
              {c.title}
              {c.unread > 0 && (
                <span className="badge small unread" aria-label={`${c.unread} unread`}>
                  {c.unread}
                </span>
              )}
            </span>
            <span className="muted small preview">{c.lastText ?? 'No messages yet'}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function Privacy({ core, readReceipts }: { core: CoreClient; readReceipts: boolean }) {
  // Local state so the box flips at once; the worker's view follows.
  const [on, setOn] = useState(readReceipts)
  useEffect(() => setOn(readReceipts), [readReceipts])
  return (
    <details className="devices">
      <summary>Privacy</summary>
      <label className="choice">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked)
            void core.setReadReceipts(e.target.checked)
          }}
        />
        Send read receipts
      </label>
      <p className="muted small">Others still see when your devices received their messages.</p>
    </details>
  )
}

function NotificationToggle({ core }: { core: CoreClient }) {
  const [state, setState] = useState<NotificationState>(notificationState)
  const { busy, error, run } = useAction()

  useEffect(() => {
    void refreshSubscription(core)
  }, [core])

  if (state === 'unsupported' || state === 'granted') return null
  return (
    <div className="notifications">
      {state === 'denied' ? (
        <p className="muted small">Notifications are blocked in your browser settings.</p>
      ) : (
        <button
          type="button"
          className="link"
          disabled={busy}
          onClick={() => run(async () => setState(await enableNotifications(core)))}
        >
          Enable notifications
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
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
  const [verifying, setVerifying] = useState<MemberInfo>()
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
              <VerificationBadge status={m.verification} />
            </span>
            {!m.isMe && (
              <button
                type="button"
                className="link small"
                onClick={() => setVerifying(m)}
                aria-label={`Verify ${m.name}`}
              >
                Verify
              </button>
            )}
            {amAdmin && !m.isMe && (
              <span className="actions">
                {!m.isAdmin && (
                  <button
                    type="button"
                    className="link small"
                    disabled={busy}
                    onClick={() => run(() => core.makeAdmin(id, m.account))}
                  >
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
      {verifying && (
        <Verify
          core={core}
          conversationId={id}
          account={verifying.account}
          name={verifying.name}
          status={members.find((m) => m.account === verifying.account)?.verification}
          onDone={() => setVerifying(undefined)}
        />
      )}
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
  peer,
  verification,
  blocked,
  request,
  onBack,
}: {
  core: CoreClient
  id: string
  title: string
  isGroup: boolean
  memberCount: number
  amAdmin: boolean
  status: ConversationSummary['status']
  peer?: string
  verification?: ConversationSummary['verification']
  blocked: boolean
  request: boolean
  onBack: () => void
}) {
  const [panel, setPanel] = useState<'add' | 'info' | 'verify' | 'report'>()
  const [reported, setReported] = useState(false)
  const active = status === 'active'
  const toggle = (p: 'add' | 'info' | 'verify' | 'report') => setPanel((current) => (current === p ? undefined : p))
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

  // Seen while visible: read receipts go out (FR-MSG-5).
  useEffect(() => {
    if (request) return
    const mark = () => document.visibilityState === 'visible' && void core.markRead(id)
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [core, id, messages, request])

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
        <VerificationBadge status={verification} />
        {isGroup && <span className="muted small">{memberCount} people</span>}
        {peer && (
          <button type="button" className="link" onClick={() => toggle('verify')}>
            {panel === 'verify' ? 'Close' : 'Verify'}
          </button>
        )}
        {peer && (
          <button type="button" className="link" onClick={() => toggle('report')}>
            {panel === 'report' ? 'Cancel' : 'Report'}
          </button>
        )}
        {peer && !blocked && (
          <button type="button" className="link danger" onClick={() => void core.block(peer)}>
            Block
          </button>
        )}
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
      {verification === 'changed' && panel !== 'verify' && (
        <p className="notice warning" role="note">
          {title}'s safety number changed since you verified it. Verify it again before sharing anything sensitive.
        </p>
      )}
      {panel === 'report' && peer && (
        <ReportForm
          core={core}
          conversationId={id}
          account={peer}
          name={title}
          blocked={blocked}
          onDone={(sent) => {
            setReported(sent)
            setPanel(undefined)
          }}
        />
      )}
      {reported && (
        <p className="notice" role="status">
          Report sent. Thank you.
        </p>
      )}
      {request && !blocked && (
        <div className="notice request" role="note">
          <p>
            {isGroup
              ? `You were added to ${title} by someone you haven't talked to.`
              : `${title} wants to chat with you.`}{' '}
            You can read their messages; reply only if you accept.
          </p>
          <span className="actions">
            <button type="button" onClick={() => void core.acceptRequest(id)}>
              Accept
            </button>
            {peer && (
              <button type="button" className="link danger" onClick={() => void core.block(peer)}>
                Block
              </button>
            )}
          </span>
        </div>
      )}
      {blocked && (
        <p className="notice warning" role="note">
          You blocked {title}. You won't get their messages.{' '}
          <button type="button" className="link" onClick={() => peer && void core.unblock(peer)}>
            Unblock
          </button>
        </p>
      )}
      {panel === 'verify' && peer && (
        <Verify
          core={core}
          conversationId={id}
          account={peer}
          name={title}
          status={verification}
          onDone={() => setPanel(undefined)}
        />
      )}
      {panel === 'info' && <GroupInfo core={core} id={id} title={title} amAdmin={amAdmin && active} active={active} />}
      <ol className="messages">
        {messages.map((m) =>
          m.kind === 'notice' ? (
            <li key={m.id} className="notice-msg small" data-testid="notice">
              {m.text}
            </li>
          ) : (
            <li key={m.id} className={m.from === 'me' ? 'mine' : 'theirs'} data-testid="message">
              {isGroup && m.from !== 'me' && <span className="sender small">{m.fromName}</span>}
              <span className="text">{m.text}</span>
              <span className="meta small">
                {new Date(m.sentAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {STATUS_LABEL[m.status] && ` · ${STATUS_LABEL[m.status]}`}
              </span>
            </li>
          ),
        )}
      </ol>
      <div ref={end} />
      {!active && (
        <p className="notice" role="note">
          {status === 'left' ? 'You left this group.' : 'You were removed from this group.'}
        </p>
      )}
      <form className="composer" onSubmit={send} hidden={!active || blocked || request}>
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

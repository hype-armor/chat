import { type FormEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { AppView, ChatMessage, ConversationSummary, MemberInfo } from '../core/protocol'
import { SetupActions, SetupBanner, useSetup } from './Banners'
import { Devices } from './Devices'
import { Invite } from './Invite'
import { Backup } from './Backup'
import { Avatar } from './Avatar'
import { Menu, type MenuItem } from './Menu'
import { Attachment } from './Attachment'
import { Recorder } from './Recorder'
import { Media } from './Media'
import { LocationCard, ShareLocation } from './Location'
import { LiveBanner, LiveCard } from './Live'
import { CallScreen } from './Call'
import { CallController } from './calls'
import { probeClip } from './media'
import type { MediaInfo } from '../core/protocol'
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

export function Chat({
  core,
  view,
  showDiagnostics,
  onDiagnostics,
}: {
  core: CoreClient
  view: Ready
  showDiagnostics: boolean
  onDiagnostics: () => void
}) {
  const [selected, setSelected] = useState<string>()
  const [panel, setPanel] = useState<'chats' | 'settings' | 'chat' | 'group'>('chats')
  const sidebar = useRef<HTMLElement>(null)
  const setup = useSetup()
  const [calls] = useState(() => new CallController(core))
  useEffect(() => () => calls.dispose(), [calls])
  calls.relayOnly = view.relayCalls
  const conversation = view.conversations.find((c) => c.id === selected)
  const select = (id: string) => {
    setPanel('chats')
    setSelected(id)
  }
  const backToChats = () => {
    setPanel('chats')
    sidebar.current?.querySelector<HTMLButtonElement>('[aria-label="New chat"]')?.focus()
  }
  const requests = view.conversations.filter((c) => c.request)
  const accepted = view.conversations.filter((c) => !c.request)

  return (
    <>
      <LiveBanner core={core} sharing={view.liveSharing} />
      <CallScreen calls={calls} />
      <div
        hidden={showDiagnostics}
        className={`chat-layout ${conversation ? 'has-selection' : ''} ${view.liveSharing.length > 0 ? 'with-banner' : ''}`}
      >
        <aside className="sidebar" ref={sidebar}>
          <header className="bar me">
            <Avatar name={view.me.displayName} id={view.me.username} />
            <div className="who">
              <strong>{view.me.displayName}</strong>
            </div>
            <Menu
              triggerLabel="New chat"
              triggerContent="✎"
              items={[
                { label: 'New chat', onSelect: () => setPanel('chat') },
                { label: 'New group', onSelect: () => setPanel('group') },
              ]}
            />
            <button
              type="button"
              className="icon"
              aria-label="Settings"
              aria-pressed={panel === 'settings'}
              onClick={() => setPanel(panel === 'settings' ? 'chats' : 'settings')}
            >
              ⚙
            </button>
          </header>
          <div className={view.connection === 'online' ? 'visually-hidden' : 'connection'} role="status">
            {view.connection === 'online' ? 'Connected' : view.connection === 'connecting' ? 'Connecting…' : 'Offline'}
          </div>
          {view.alerts.map((a) => (
            <div key={a.id} className="alert" role="alert">
              <p>{a.text}</p>
              <button type="button" className="link small" onClick={() => void core.dismissAlert(a.id)}>
                Dismiss
              </button>
            </div>
          ))}
          {panel === 'settings' ? (
            <nav className="settings" aria-label="Settings">
              <div className="settings-head">
                <button type="button" className="link" onClick={backToChats}>
                  ← Chats
                </button>
                <h2>Settings</h2>
              </div>
              <p className="muted small settings-identity">Your username: {view.me.username}</p>
              <NotificationToggle core={core} />
              <Backup core={core} backup={view.backup} />
              <Invite core={core} />
              <Devices core={core} />
              <Privacy core={core} readReceipts={view.readReceipts} relayCalls={view.relayCalls} />
              <Media core={core} media={view.media} />
              <BlockedList core={core} />
              <DeleteAccount core={core} />
              <SetupActions setup={setup} />
              <section className="devices" aria-label="About / Diagnostics">
                <h3>About / Diagnostics</h3>
                <button type="button" className="link" onClick={onDiagnostics}>
                  Diagnostics
                </button>
              </section>
            </nav>
          ) : panel === 'chat' || panel === 'group' ? (
            <section className="compose-panel" aria-label={panel === 'chat' ? 'New chat' : 'New group'}>
              <div className="settings-head">
                <button type="button" className="link" onClick={backToChats}>
                  ← Back
                </button>
                <h2>{panel === 'chat' ? 'New chat' : 'New group'}</h2>
              </div>
              {panel === 'chat' ? <NewChat core={core} onStarted={select} /> : <NewGroup core={core} onCreated={select} />}
            </section>
          ) : (
            <>
              <SetupBanner setup={setup} />
              <nav aria-label="Conversations" className="conversation-nav">
                {requests.length > 0 && (
                  <details className="message-requests">
                    <summary>Message requests ({requests.length})</summary>
                    <nav aria-label="Requests">
                      <ConversationList conversations={requests} selected={selected} onSelect={select} />
                    </nav>
                  </details>
                )}
                <ConversationList conversations={accepted} selected={selected} onSelect={select} />
                {accepted.length === 0 && (
                  <div className="empty">
                    <p className="muted">No conversations yet</p>
                    <button type="button" onClick={() => setPanel('chat')}>
                      Start a chat
                    </button>
                    <p className="muted small">
                      Not here yet?{' '}
                      <button type="button" className="link" onClick={() => setPanel('settings')}>
                        Invite someone
                      </button>
                    </p>
                  </div>
                )}
              </nav>
            </>
          )}
        </aside>
        {conversation ? (
          <Conversation
            key={conversation.id}
            core={core}
            calls={calls}
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
    </>
  )
}

/** Today: the time; otherwise the date. */
function formatWhen(at: number): string {
  const d = new Date(at)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
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
            <Avatar name={c.title} id={c.peer ?? c.id} />
            <span className="title">
              {c.title}
              {c.unread > 0 && (
                <span className="badge small unread" aria-label={`${c.unread} unread`}>
                  {c.unread}
                </span>
              )}
            </span>
            <span className="muted small preview">{c.lastText ?? 'No messages yet'}</span>
            <span className="muted small when">{formatWhen(c.lastAt)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function Privacy({ core, readReceipts, relayCalls }: { core: CoreClient; readReceipts: boolean; relayCalls: boolean }) {
  // Local state so the boxes flip at once; the worker's view follows.
  const [on, setOn] = useState(readReceipts)
  useEffect(() => setOn(readReceipts), [readReceipts])
  const [relay, setRelay] = useState(relayCalls)
  useEffect(() => setRelay(relayCalls), [relayCalls])
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
      <label className="choice">
        <input
          type="checkbox"
          checked={relay}
          onChange={(e) => {
            setRelay(e.target.checked)
            void core.setRelayCalls(e.target.checked)
          }}
        />
        Always relay calls
      </label>
      <p className="muted small">
        Calls go through this service's relay, so the people you call don't see your IP address. Calls may sound or
        look a little worse.
      </p>
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
  const [username, setUsername] = useState('')
  const { busy, error, run } = useAction()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      onStarted(await core.startChat(username.trim()))
      setUsername('')
    })
  }

  return (
    <form className="new-chat" onSubmit={submit}>
      <label>
        Contact's username
        <input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          placeholder="alex.27"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
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

/** Splits a free-form list of usernames (commas, spaces or new lines). */
export function parseUsernames(text: string): string[] {
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
  const [usernames, setUsernames] = useState('')
  const { busy, error, run } = useAction()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      onCreated(await core.createGroup(name, parseUsernames(usernames)))
      setName('')
      setUsernames('')
    })
  }

  return (
    <form className="new-group" onSubmit={submit}>
      <label>
        Group name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
      </label>
      <label>
        Members' usernames
        <textarea
          value={usernames}
          onChange={(e) => setUsernames(e.target.value)}
          required
          rows={3}
          placeholder={'alex.27\nsam.04'}
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
  )
}

function AddPeople({ core, id, onDone }: { core: CoreClient; id: string; onDone: () => void }) {
  const [usernames, setUsernames] = useState('')
  const { busy, error, run } = useAction()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      await core.addMembers(id, parseUsernames(usernames))
      setUsernames('')
      onDone()
    })
  }

  return (
    <form className="add-people" onSubmit={submit}>
      <label>
        Usernames to add
        <input
          value={usernames}
          onChange={(e) => setUsernames(e.target.value)}
          required
          placeholder="alex.27"
          autoCapitalize="none"
          spellCheck={false}
        />
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
  calls,
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
  calls: CallController
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
  const detailsId = useId()
  const [reported, setReported] = useState(false)
  const active = status === 'active'
  const toggle = (p: 'add' | 'info' | 'verify' | 'report') => setPanel((current) => (current === p ? undefined : p))
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState<string>()
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLOListElement>(null)
  const atBottom = useRef(true)
  const lastScrollTop = useRef(0)
  const previousMessages = useRef<ChatMessage[]>([])
  const [newMessages, setNewMessages] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const menuItems: MenuItem[] = [
    ...(isGroup ? [{ label: 'Group info', onSelect: () => toggle('info') }] : []),
    ...(peer ? [{ label: 'Verify safety number', onSelect: () => toggle('verify') }] : []),
    ...(active ? [{ label: 'Add people', onSelect: () => toggle('add') }] : []),
    ...(peer ? [{ label: 'Report', onSelect: () => toggle('report') }] : []),
    ...(peer && !blocked ? [{ label: 'Block', onSelect: () => void core.block(peer), danger: true }] : []),
  ]

  const scrollToBottom = useCallback(() => {
    atBottom.current = true
    setNewMessages(false)
    if (viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
      lastScrollTop.current = viewport.current.scrollTop
    }
  }, [])

  const onScroll = useCallback(() => {
    const list = viewport.current
    if (!list) return
    // A queued event from our own scroll must not unpin newly grown content.
    if (list.scrollTop === lastScrollTop.current) return
    lastScrollTop.current = list.scrollTop
    atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 80
    if (atBottom.current) setNewMessages(false)
  }, [])

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

  useLayoutEffect(() => {
    onScroll()
    const previousIds = new Set(previousMessages.current.map((m) => m.id))
    const added = messages.filter((m) => !previousIds.has(m.id))
    previousMessages.current = messages
    if (atBottom.current || added.some((m) => m.from === 'me')) {
      scrollToBottom()
    } else if (added.length > 0) {
      setNewMessages(true)
    }
  }, [messages, onScroll, scrollToBottom])

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      onScroll()
      if (atBottom.current) scrollToBottom()
    })
    // The list grows with loaded media; the viewport can shrink as panels open.
    observer.observe(content.current!)
    observer.observe(viewport.current!)
    return () => observer.disconnect()
  }, [onScroll, scrollToBottom])

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    await core.sendText(id, text)
  }

  // The draft, if any, goes with the file as its caption.
  const attach = async (file: File | undefined, recorded?: MediaInfo) => {
    if (picker.current) picker.current.value = ''
    if (!file) return
    setAttaching(true)
    setAttachError(undefined)
    try {
      const media = recorded ?? (await probeClip(file).catch(() => undefined))
      await core.sendFile(id, file, draft.trim(), media)
      setDraft('')
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e))
    } finally {
      setAttaching(false)
    }
  }

  return (
    <section className="conversation" aria-label={`Conversation with ${title}`}>
      <header className="bar conversation-bar">
        <div className="title-row">
          <button type="button" className="link back" onClick={onBack} aria-label="Back to conversations">
            ←
          </button>
          <button
            type="button"
            className="conversation-title"
            aria-label={isGroup ? 'Group info' : 'Verify safety number'}
            aria-describedby={detailsId}
            onClick={() => toggle(isGroup ? 'info' : 'verify')}
          >
            <Avatar name={title} id={peer ?? id} />
            <span className="who" id={detailsId}>
              <span className="conversation-name" role="heading" aria-level={2}>
                {title}
              </span>
              {isGroup && <span className="muted small">{memberCount} people</span>}
              <VerificationBadge status={verification} />
            </span>
          </button>
        </div>
        <div className="header-actions">
          {peer && active && !blocked && !request && (
            <>
              <button
                type="button"
                className="icon"
                aria-label="Voice call"
                onClick={() => void calls.start(id, title, false).catch((e) => setAttachError(String(e.message ?? e)))}
              >
                📞
              </button>
              <button
                type="button"
                className="icon"
                aria-label="Video call"
                onClick={() => void calls.start(id, title, true).catch((e) => setAttachError(String(e.message ?? e)))}
              >
                🎥
              </button>
            </>
          )}
          <Menu key={id} triggerLabel="Conversation menu" triggerContent="⋮" items={menuItems} />
        </div>
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
      <div className="messages-viewport" ref={viewport} onScroll={onScroll}>
        <ol className="messages" ref={content}>
          {messages.map((m) =>
            m.kind === 'notice' ? (
              <li key={m.id} className="notice-msg small" data-testid="notice">
                {m.text}
              </li>
            ) : (
              <li key={m.id} className={m.from === 'me' ? 'mine' : 'theirs'} data-testid="message">
                {isGroup && m.from !== 'me' && <span className="sender small">{m.fromName}</span>}
                {m.file && (
                  <Attachment
                    core={core}
                    conversationId={id}
                    messageId={m.id}
                    file={m.file}
                    sending={m.status === 'sending'}
                  />
                )}
                {m.location && <LocationCard core={core} location={m.location} />}
                {m.live && <LiveCard core={core} conversationId={id} message={m} live={m.live} />}
                {m.text && <span className="text">{m.text}</span>}
                <span className="meta small">
                  {new Date(m.sentAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {STATUS_LABEL[m.status] && ` · ${STATUS_LABEL[m.status]}`}
                  {m.status === 'failed' && m.error && `: ${m.error}`}
                </span>
                {m.status === 'failed' && active && (
                  <button type="button" className="link small" onClick={() => void core.retryMessage(id, m.id)}>
                    Retry
                  </button>
                )}
              </li>
            ),
          )}
        </ol>
      </div>
      {!active && (
        <p className="notice" role="note">
          {status === 'restoring'
            ? 'Restored from your backup. Waiting for the others to add this device back; this takes a moment once they are online.'
            : status === 'left'
              ? 'You left this group.'
              : 'You were removed from this group.'}
        </p>
      )}
      {attachError && (
        <p className="notice warning" role="alert">
          {attachError}
        </p>
      )}
      <div className="new-messages">
        {newMessages && (
          <button type="button" onClick={scrollToBottom}>
            ↓ New messages
          </button>
        )}
      </div>
      <form className="composer" onSubmit={send} hidden={!active || blocked || request}>
        <input
          ref={picker}
          type="file"
          hidden
          data-testid="attach-input"
          onChange={(e) => void attach(e.target.files?.[0])}
        />
        <button
          type="button"
          className="icon"
          onClick={() => picker.current?.click()}
          disabled={attaching}
          aria-label="Attach a photo or file"
        >
          {attaching ? '…' : '+'}
        </button>
        <ShareLocation core={core} conversationId={id} disabled={attaching} onError={setAttachError} />
        <Recorder
          disabled={attaching}
          onRecorded={(file, media) => void attach(file, media)}
          onError={setAttachError}
        />
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

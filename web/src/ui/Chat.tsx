import { Fragment, type FormEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { AppView, ChatMessage, ConversationSummary, GroupCallStatus, MemberInfo } from '../core/protocol'
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
import { GroupCallScreen, useGroupCall } from './GroupCall'
import { GroupCallController } from './groupCall'
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
  received: 'Received',
}

const STATUS_ICON: Record<ChatMessage['status'], string> = {
  sending: '…',
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓',
  failed: '!',
  received: '',
}

export function dayLabel(at: number, now: number): string {
  const date = new Date(at)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

export function messageDateTime(at: number): string | undefined {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function messageLayout(messages: readonly ChatMessage[], now: number) {
  const sameDay = (a: ChatMessage, b: ChatMessage) =>
    new Date(a.sentAt).toDateString() === new Date(b.sentAt).toDateString()
  const joined = (a: ChatMessage | undefined, b: ChatMessage | undefined) =>
    !!a && !!b && a.kind !== 'notice' && b.kind !== 'notice' &&
    a.from === b.from && sameDay(a, b) && b.sentAt >= a.sentAt && b.sentAt - a.sentAt <= 3 * 60_000
  return messages.map((message, index) => ({
    message,
    day: index === 0 || !sameDay(messages[index - 1], message) ? dayLabel(message.sentAt, now) : undefined,
    first: !joined(messages[index - 1], message),
    last: !joined(message, messages[index + 1]),
  }))
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
  const [groupCalls] = useState(() => {
    const g = new GroupCallController(core)
    g.otherBusy = () => calls.busy
    calls.otherBusy = () => g.busy
    return g
  })
  useEffect(
    () => () => {
      calls.dispose()
      groupCalls.dispose()
    },
    [calls, groupCalls],
  )
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
      <GroupCallScreen calls={groupCalls} />
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
              <Privacy
                core={core}
                readReceipts={view.readReceipts}
                relayCalls={view.relayCalls}
                callStats={view.callStats}
              />
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
            groupCalls={groupCalls}
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

/** "Call in progress · Join" while people are in the group's latest call (ADR-0031). */
function OngoingCall({
  core,
  groupCalls,
  id,
  title,
}: {
  core: CoreClient
  groupCalls: GroupCallController
  id: string
  title: string
}) {
  const [call, setCall] = useState<GroupCallStatus>()
  const inCall = useGroupCall(groupCalls)
  useEffect(() => {
    let live = true
    const check = () =>
      core
        .groupCallStatus(id)
        .then((c) => live && setCall(c))
        .catch(() => live && setCall(undefined))
    void check()
    const timer = setInterval(check, 15_000)
    const unsubscribe = core.subscribe((e) => e.type === 'messages' && e.conversationId === id && void check())
    return () => {
      live = false
      clearInterval(timer)
      unsubscribe()
    }
  }, [core, id])
  if (!call || (inCall && inCall.phase !== 'incoming')) return null
  return (
    <p className="notice" role="note">
      {call.video ? '🎥' : '📞'} Call in progress · {call.participants} {call.participants === 1 ? 'person' : 'people'}{' '}
      <button
        type="button"
        className="link"
        onClick={() => void groupCalls.join(id, call.callId, title, call.video).catch(() => undefined)}
      >
        Join
      </button>
    </p>
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

function Privacy({
  core,
  readReceipts,
  relayCalls,
  callStats,
}: {
  core: CoreClient
  readReceipts: boolean
  relayCalls: boolean
  callStats: boolean
}) {
  const [stats, setStats] = useState(callStats)
  useEffect(() => setStats(callStats), [callStats])
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
      <label className="choice">
        <input
          type="checkbox"
          checked={stats}
          onChange={(e) => {
            setStats(e.target.checked)
            void core.setCallStats(e.target.checked)
          }}
        />
        Share anonymous call statistics
      </label>
      <p className="muted small">
        Once a day, how many of your calls connected or failed and how long they took to connect, with nothing that
        identifies you, who you called or when. It helps make calls reliable.
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
  memberCount,
  adding,
  onAdd,
  onAdded,
}: {
  core: CoreClient
  id: string
  title: string
  amAdmin: boolean
  active: boolean
  memberCount: number
  adding: boolean
  onAdd: () => void
  onAdded: () => void
}) {
  const [members, setMembers] = useState<MemberInfo[]>([])
  const [verifying, setVerifying] = useState<MemberInfo>()
  const [name, setName] = useState(title)
  const [editing, setEditing] = useState(false)
  const verifyBack = useRef<HTMLButtonElement>(null)
  const verifyTrigger = useRef<HTMLElement | null>(null)
  const editTrigger = useRef<HTMLButtonElement>(null)
  const { busy, error, run } = useAction()
  const verifyingOpen = !!verifying

  useLayoutEffect(() => {
    if (!verifyingOpen) return
    verifyBack.current?.focus({ preventScroll: true })
    return () => verifyTrigger.current?.focus({ preventScroll: true })
  }, [verifyingOpen])

  useLayoutEffect(() => {
    if (!editing) return
    return () => editTrigger.current?.focus({ preventScroll: true })
  }, [editing])

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
      <div className="details-identity">
        <Avatar name={title} id={id} size={5} />
        <div className="details-name">
          <strong>{title}</strong>
          {amAdmin && (
            <button
              type="button"
              className="icon"
              ref={editTrigger}
              aria-label="Edit group name"
              hidden={editing}
              onClick={() => {
                setName(title)
                setEditing(true)
              }}
            >
              ✎
            </button>
          )}
        </div>
        <span className="muted small">{memberCount} people</span>
      </div>
      {amAdmin && editing && (
        <form
          className="rename"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await core.renameGroup(id, name.trim())
              setEditing(false)
            })
          }}
        >
          <label>
            Group name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
          </label>
          <span className="actions">
            <button type="submit" disabled={busy || !name.trim() || name.trim() === title}>Save</button>
            <button type="button" className="link" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          </span>
        </form>
      )}
      {verifying && (
        <div>
          <button ref={verifyBack} type="button" className="link" onClick={() => setVerifying(undefined)}>← Members</button>
          <Verify
            key={verifying.account}
            core={core}
            conversationId={id}
            account={verifying.account}
            name={verifying.name}
            status={members.find((m) => m.account === verifying.account)?.verification}
            onDone={() => setVerifying(undefined)}
          />
        </div>
      )}
      <div className="details-members" hidden={!!verifying}>
        <h3>Members</h3>
        {active && <button type="button" className="link add-member" onClick={onAdd}>＋ Add people</button>}
        {adding && active && <AddPeople core={core} id={id} onDone={onAdded} />}
        <ul className="members" aria-label="Members">
          {members.map((m) => (
            <li key={m.account}>
              <Avatar name={m.name} id={m.account} />
              <span className="member-name">
                <span>{m.name}</span>
                {m.isMe && <span className="badge small">You</span>}
                {m.isAdmin && <span className="badge small">Admin</span>}
                <VerificationBadge status={m.verification} />
              </span>
              {!m.isMe && (
                <Menu
                  triggerLabel={`Actions for ${m.name}`}
                  triggerContent="⋮"
                  items={[
                    {
                      label: 'Verify',
                      onSelect: () => {
                        verifyTrigger.current = document.activeElement as HTMLElement | null
                        setVerifying(m)
                      },
                    },
                    ...(amAdmin ? [
                      ...(!m.isAdmin ? [{
                        label: 'Make admin',
                        onSelect: () => { if (!busy) void run(() => core.makeAdmin(id, m.account)) },
                      }] : []),
                      {
                        label: 'Remove',
                        danger: true,
                        onSelect: () => { if (!busy) void run(() => core.removeMember(id, m.account)) },
                      },
                    ] : []),
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
      {active && (
        <div className="details-danger">
          <h3>Danger zone</h3>
          <button
            type="button"
            className="link danger"
            disabled={busy}
            onClick={() => run(async () => {
              await core.leaveGroup(id)
              onAdded()
            })}
          >
            Leave group
          </button>
        </div>
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
  groupCalls,
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
  groupCalls: GroupCallController
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
  const detailsHeadingId = useId()
  const details = useRef<HTMLElement>(null)
  const detailsClose = useRef<HTMLButtonElement>(null)
  const detailsTrigger = useRef<HTMLElement | null>(null)
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 40rem)').matches)
  const [reported, setReported] = useState(false)
  const active = status === 'active'
  const openPanel = (p: 'add' | 'info' | 'verify' | 'report') => {
    if (!panel) detailsTrigger.current = document.activeElement as HTMLElement | null
    setPanel(p)
  }
  const panelOpen = !!panel

  useEffect(() => {
    const media = matchMedia('(max-width: 40rem)')
    const update = () => setNarrow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    if (!panelOpen) return
    detailsClose.current?.focus({ preventScroll: true })
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Let an open Menu dismiss itself before dismissing the details view.
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
      event.preventDefault()
      setPanel(undefined)
    }
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('keydown', escape)
      detailsTrigger.current?.focus({ preventScroll: true })
    }
  }, [panelOpen])
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
  const composer = useRef<HTMLTextAreaElement>(null)
  const [recording, setRecording] = useState(false)
  const wasRecording = useRef(false)
  const menuItems: MenuItem[] = [
    ...(isGroup ? [{ label: 'Group info', onSelect: () => openPanel('info') }] : []),
    ...(peer ? [{ label: 'Verify safety number', onSelect: () => openPanel('verify') }] : []),
    ...(active ? [{ label: 'Add people', onSelect: () => openPanel('add') }] : []),
    ...(peer ? [{ label: 'Report', onSelect: () => openPanel('report') }] : []),
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

  useLayoutEffect(() => {
    const input = composer.current
    if (!input || recording) return
    const resize = () => {
      input.style.height = 'auto'
      input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`
    }
    resize()
    let width = input.clientWidth
    const observer = new ResizeObserver(() => {
      if (width === input.clientWidth) return
      width = input.clientWidth
      resize()
    })
    observer.observe(input)
    return () => observer.disconnect()
  }, [draft, recording])

  useLayoutEffect(() => {
    if (wasRecording.current && !recording) composer.current?.focus({ preventScroll: true })
    wasRecording.current = recording
  }, [recording])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    // Keyboard activation unmounts the focused Send button; pointer sends keep focus here.
    composer.current?.focus({ preventScroll: true })
    try {
      await core.sendText(id, text)
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e))
    }
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
      composer.current?.focus({ preventScroll: true })
    }
  }

  return (
    <div className={`conversation-shell${panel ? ' details-open' : ''}`}>
    <section className="conversation" aria-label={`Conversation with ${title}`} inert={panelOpen && narrow}>
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
            aria-expanded={panelOpen}
            onClick={() => openPanel(isGroup ? 'info' : 'verify')}
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
          {isGroup && active && !request && (
            <>
              <button
                type="button"
                className="icon"
                aria-label="Group voice call"
                onClick={() => void groupCalls.start(id, title, false).catch((e) => setAttachError(String(e.message ?? e)))}
              >
                📞
              </button>
              <button
                type="button"
                className="icon"
                aria-label="Group video call"
                onClick={() => void groupCalls.start(id, title, true).catch((e) => setAttachError(String(e.message ?? e)))}
              >
                🎥
              </button>
            </>
          )}
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
      {isGroup && active && !request && <OngoingCall core={core} groupCalls={groupCalls} id={id} title={title} />}
      {verification === 'changed' && panel !== 'verify' && (
        <p className="notice warning" role="note">
          {title}'s safety number changed since you verified it. Verify it again before sharing anything sensitive.
        </p>
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
      <div className="messages-viewport" ref={viewport} onScroll={onScroll}>
        <ol className="messages" ref={content}>
          {messageLayout(messages, Date.now()).map(({ message: m, day, first, last }) => (
            <Fragment key={m.id}>
              {day && <li role="separator" aria-label={day} className="day-separator small">{day}</li>}
              {m.kind === 'notice' ? (
                <li className="notice-msg small" data-testid="notice">
                  {m.text}
                </li>
              ) : (
                <li
                  className={`${m.from === 'me' ? 'mine' : 'theirs'}${first ? ' run-first' : ''}${last ? ' run-last' : ''}`}
                  data-testid="message"
                  title={new Date(m.sentAt).toLocaleString()}
                >
                  <span className={isGroup && m.from !== 'me' && first ? 'sender small' : 'visually-hidden'}>
                    {m.from === 'me' ? 'You' : m.fromName ?? (isGroup ? m.from : title)}
                  </span>
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
                  <span className={last || m.status === 'failed' ? 'meta small' : 'visually-hidden'}>
                    <time
                      className={last ? undefined : 'visually-hidden'}
                      dateTime={messageDateTime(m.sentAt)}
                      title={new Date(m.sentAt).toLocaleString()}
                      aria-label={new Date(m.sentAt).toLocaleString()}
                    >
                      {new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </time>
                    {m.status === 'failed' ? (
                      <span className="message-failure">
                        {STATUS_LABEL[m.status]}{m.error && `: ${m.error}`}
                      </span>
                    ) : (
                      <span
                        className={m.from === 'me' && last ? `message-status ${m.status}` : 'visually-hidden'}
                        role="img"
                        aria-label={STATUS_LABEL[m.status]}
                      >
                        {STATUS_ICON[m.status]}
                      </span>
                    )}
                  </span>
                  {m.status === 'failed' && active && (
                    <button type="button" className="link small" onClick={() => void core.retryMessage(id, m.id)}>
                      Retry
                    </button>
                  )}
                </li>
              )}
            </Fragment>
          ))}
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
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
        hidden={!active || blocked || request}
      >
        <input
          ref={picker}
          type="file"
          hidden
          data-testid="attach-input"
          onChange={(e) => void attach(e.target.files?.[0])}
        />
        <ShareLocation
          core={core}
          conversationId={id}
          onError={setAttachError}
          onSend={() => composer.current?.focus({ preventScroll: true })}
          trigger={(locate) =>
            recording ? null : attaching ? (
              <span className="small" role="status">Attaching…</span>
            ) : (
              <Menu
                triggerLabel="Add attachment"
                triggerContent="+"
                items={[
                  { label: 'Photo or file', onSelect: () => picker.current?.click() },
                  { label: 'Location', onSelect: locate },
                ]}
              />
            )
          }
        />
        <label className="visually-hidden" htmlFor="composer">
          Message
        </label>
        <textarea
          ref={composer}
          id="composer"
          rows={1}
          hidden={recording}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' && !e.shiftKey &&
              !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 &&
              !matchMedia('(pointer: coarse)').matches
            ) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="Message"
          autoComplete="off"
          maxLength={4000}
        />
        {draft.length > 0 && !recording && (
          <button type="submit" disabled={!draft.trim()} onMouseDown={(e) => e.preventDefault()}>
            Send
          </button>
        )}
        <Recorder
          hidden={draft.length > 0}
          disabled={attaching}
          onRecordingChange={setRecording}
          onRecorded={(file, media) => void attach(file, media)}
          onError={setAttachError}
        />
      </form>
    </section>
    {panel && (
      <aside
        className="conversation-details"
        aria-labelledby={detailsHeadingId}
        ref={details}
        onKeyDown={(event) => {
          if (!narrow || event.key !== 'Tab') return
          const buttons = Array.from(details.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ) ?? []).filter((element) => element.getClientRects().length > 0)
          const first = buttons[0]
          const last = buttons[buttons.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <header className="details-head">
          <button
            type="button"
            className="link"
            ref={detailsClose}
            aria-label={narrow ? 'Back to conversation' : 'Close details'}
            onClick={() => setPanel(undefined)}
          >{narrow ? '← Back' : '✕'}</button>
          <h2 id={detailsHeadingId}>Conversation details</h2>
        </header>
        <div className="details-content">
          {isGroup ? (
            <GroupInfo
              core={core}
              id={id}
              title={title}
              amAdmin={amAdmin && active}
              active={active}
              memberCount={memberCount}
              adding={panel === 'add'}
              onAdd={() => setPanel('add')}
              onAdded={() => setPanel(undefined)}
            />
          ) : (
            <>
              <div className="details-identity">
                <Avatar name={title} id={peer ?? id} size={5} />
                <strong>{title}</strong>
                <VerificationBadge status={verification} />
              </div>
              {panel === 'add' && active ? (
                <AddPeople core={core} id={id} onDone={() => setPanel(undefined)} />
              ) : panel === 'report' && peer ? (
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
              ) : peer && (
                <Verify
                  core={core}
                  conversationId={id}
                  account={peer}
                  name={title}
                  status={verification}
                  onDone={() => setPanel(undefined)}
                />
              )}
              {peer && (
                <div className="details-danger">
                  <h3>Danger zone</h3>
                  <button type="button" className="link danger" onClick={() => void (
                    blocked ? core.unblock(peer) : core.block(peer)
                  )}>{blocked ? 'Unblock' : 'Block'}</button>
                  <button type="button" className="link danger" onClick={() => setPanel('report')}>Report</button>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    )}
    </div>
  )
}

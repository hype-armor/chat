import { useEffect, useState } from 'react'
import type { CoreClient } from '../core/client'
import type { ConversationSummary, MemberInfo } from '../core/protocol'
import './restrictedChannels.css'

/** These are worker-authorized summaries, not a directory of the parent's channels. */
export function visibleChildChannels(conversations: ConversationSummary[], parentId: string) {
  return conversations.filter((conversation) => conversation.channelParentId === parentId)
}

export function channelInviteCandidates(parent: MemberInfo[], current: MemberInfo[]) {
  const existing = new Set(current.map((member) => member.account))
  return parent.filter((member) => !member.isMe && !member.blocked && !!member.username && !existing.has(member.account))
}

export function validChannelName(name: string) {
  const bytes = new TextEncoder().encode(name.trim()).length
  return bytes > 0 && bytes <= 512
}

export function RestrictedChannelForm({ core, parentId, channelId, onDone }: {
  core: CoreClient
  parentId: string
  channelId?: string
  onDone: (id?: string) => void
}) {
  const [name, setName] = useState('')
  const [parent, setParent] = useState<MemberInfo[]>([])
  const [current, setCurrent] = useState<MemberInfo[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let live = true
    setLoaded(false)
    setSelected([])
    void Promise.all([core.members(parentId), channelId ? core.members(channelId) : Promise.resolve([])])
      .then(([members, existing]) => {
        if (!live) return
        setParent(members)
        setCurrent(existing)
        setLoaded(true)
      }).catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)) })
    return () => { live = false }
  }, [core, parentId, channelId])
  const candidates = channelInviteCandidates(parent, current)
  return <form className="add-people restricted-channel-form" aria-label={channelId ? 'Invite to private channel' : 'Create private channel'} onSubmit={(event) => {
    event.preventDefault()
    if (busy || !loaded || selected.length === 0 || (!channelId && !validChannelName(name))) return
    setBusy(true)
    setError(undefined)
    const usernames = candidates.filter((member) => selected.includes(member.account)).map((member) => member.username!)
    void (async () => {
      try {
        if (channelId) {
          await core.inviteToRestrictedChannel(channelId, usernames)
          onDone()
        } else onDone(await core.createRestrictedChannel(parentId, name.trim(), usernames))
      } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
      finally { setBusy(false) }
    })()
  }}>
    {!channelId && <label>Channel name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>}
    {!channelId && name.trim() && !validChannelName(name) && <p role="alert">Use at most 512 UTF-8 bytes for the channel name.</p>}
    <fieldset disabled={busy || !loaded}>
      <legend>Parent group members</legend>
      {candidates.map((member) => <label key={member.account} className="channel-member">
        <input type="checkbox" checked={selected.includes(member.account)} onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, member.account] : previous.filter((account) => account !== member.account))} />
        {member.name} (@{member.username})
      </label>)}
    </fieldset>
    {!loaded && !error && <p role="status">Loading parent group members…</p>}
    {loaded && candidates.length === 0 && <p role="status">No eligible parent group members are available.</p>}
    {loaded && parent.some((member) => !member.isMe && !member.username) && <p className="small">Some members have no cached current username. Refresh their profile before inviting them.</p>}
    <p className="small">Only invited members can see this channel. New members do not receive earlier history by default.</p>
    <button type="submit" disabled={busy || !loaded || selected.length === 0 || (!channelId && !validChannelName(name))}>{channelId ? 'Invite members' : 'Create private channel'}</button>
    {error && <p role="alert" className="error">{error}</p>}
  </form>
}

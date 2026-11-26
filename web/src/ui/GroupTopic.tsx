import { useLayoutEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import './groupTopic.css'

export const GROUP_TOPIC_MAX_BYTES = 512
export const topicBytes = (text: string) => new TextEncoder().encode(text).byteLength

/** Only worker-confirmed summaries can enable the editor. */
export function GroupTopic({ core, id, topic, canEdit }: {
  core: CoreClient
  id: string
  topic?: string
  canEdit: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [queued, setQueued] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const section = useRef<HTMLElement>(null)
  const sending = useRef(false)
  const wasEditing = useRef(false)
  const bytes = topicBytes(text)

  useLayoutEffect(() => {
    if (wasEditing.current && !editing) (trigger.current ?? section.current)?.focus({ preventScroll: true })
    wasEditing.current = editing
  }, [editing])

  if (!canEdit && topic === undefined && !editing && !queued) return null
  return <section ref={section} tabIndex={-1} className="group-topic" aria-label="Group topic">
    <h3>Topic</h3>
    <p className="group-topic-text">{topic === undefined ? 'Topic not known on this device.' : topic === '' ? 'No topic.' : topic}</p>
    {canEdit && !editing && <button type="button" className="link" ref={trigger} onClick={() => {
      setText(topic ?? '')
      setError(undefined)
      setQueued(false)
      setEditing(true)
    }}>Edit topic</button>}
    {editing && <form onSubmit={async (event) => {
      event.preventDefault()
      if (!canEdit || sending.current || bytes > GROUP_TOPIC_MAX_BYTES) return
      sending.current = true
      setBusy(true)
      setError(undefined)
      try {
        await core.setGroupTopic(id, text)
        setQueued(true)
        setEditing(false)
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
      } finally {
        sending.current = false
        setBusy(false)
      }
    }}>
      <label>Group topic
        <textarea autoFocus value={text} readOnly={busy} aria-describedby="group-topic-help group-topic-bytes" onChange={(event) => setText(event.target.value)} />
      </label>
      <p id="group-topic-bytes" className={bytes > GROUP_TOPIC_MAX_BYTES ? 'error small' : 'muted small'}>{bytes} / {GROUP_TOPIC_MAX_BYTES} UTF-8 bytes</p>
      <p id="group-topic-help" className="muted small">Leave empty to clear. Updates are queued for current members. Earlier topics are not shared with new members yet.</p>
      <span className="actions">
        <button type="submit" disabled={!canEdit || busy || bytes > GROUP_TOPIC_MAX_BYTES}>{busy ? 'Queueing…' : 'Queue topic update'}</button>
        <button type="button" className="link" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
      </span>
      {busy && <p role="status" className="muted small">Queueing topic update…</p>}
      {!busy && !canEdit && <p role="status" className="muted small">Topic editing is unavailable right now. Your draft is still here.</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </form>}
    {queued && <p role="status" className="muted small">Topic update queued. This does not confirm delivery to every member.</p>}
  </section>
}

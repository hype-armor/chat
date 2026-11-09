// Photos and files in a conversation (ADR-0024). Files are decrypted in the
// core worker; this only shows what it hands back.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CoreClient } from '../core/client'
import { type FileInfo, isPhoto, isPlayable } from '../core/protocol'
import { formatDuration } from './media'

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** An object URL for `blob`, revoked when it changes or on unmount. */
function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>()
  useLayoutEffect(() => {
    if (!blob) return setUrl(undefined)
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return url
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return url
}

export function Attachment({
  core,
  conversationId,
  messageId,
  file,
  sending,
}: {
  core: CoreClient
  conversationId: string
  messageId: string
  file: FileInfo
  /** Ours and still uploading. */
  sending: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const lifetime = useRef(0)
  const downloads = useRef(new Set<string>())
  useLayoutEffect(() => {
    const node = root.current
    lifetime.current++
    return () => {
      lifetime.current++
      node?.querySelectorAll<HTMLMediaElement>('audio, video').forEach((media) => {
        media.pause()
        media.removeAttribute('src')
        media.load()
      })
      for (const url of downloads.current) URL.revokeObjectURL(url)
      downloads.current.clear()
    }
  }, [conversationId, messageId])
  const photo = isPhoto(file.mime)
  const playable = isPlayable(file.mime)
  const video = playable && file.mime.startsWith('video/')
  const generic = !photo && !playable
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toUpperCase() : ''
  const fileType = ['PDF', 'TXT', 'CSV', 'DOC', 'DOCX', 'XLS', 'XLSX', 'ZIP', 'GZ', 'TAR'].includes(extension) ? extension : 'FILE'
  const [thumb] = useState(() => (file.thumbnail ? new Blob([file.thumbnail], { type: 'image/jpeg' }) : undefined))
  const [full, setFull] = useState<Blob>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const thumbUrl = useObjectUrl(thumb)
  const fullUrl = useObjectUrl(full)
  const [progress, setProgress] = useState<number>()

  useEffect(() => {
    const unsubscribe = core.subscribe((e) => {
      if (e.type === 'progress' && e.messageId === messageId) {
        setProgress(e.done < e.total ? e.done / e.total : undefined)
      }
    })
    return () => void unsubscribe()
  }, [core, messageId])

  const open = async () => {
    const generation = lifetime.current
    if (full) return full
    setBusy(true)
    setError(undefined)
    try {
      const blob = await core.openAttachment(conversationId, messageId)
      if (lifetime.current !== generation) return undefined
      if (photo || playable) setFull(blob)
      return blob
    } catch (e) {
      if (lifetime.current === generation) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (lifetime.current === generation) setBusy(false)
    }
  }

  // Photos already on this device show full size (ADR-0025).
  useEffect(() => {
    if (photo && file.downloaded && !full && !busy) void open()
  }, [photo, file.downloaded])

  const download = async () => {
    const generation = lifetime.current
    const blob = await open()
    if (blob && lifetime.current === generation) downloads.current.add(save(blob, file.name))
  }

  const aspect = file.width && file.height ? file.width / file.height : undefined
  const mediaStyle = {
    aspectRatio: aspect,
    // Keep even the placeholder within the height cap, without enlarging tiny media past 4rem.
    width: aspect && file.width
      ? `min(${Math.max(file.width, 64 * Math.min(1, aspect))}px, calc(min(60vh, 22rem) * ${aspect}))`
      : undefined,
  }
  const label = file.voiceNote ? 'Voice note' : file.name
  const duration = file.durationMs ? ` · ${formatDuration(file.durationMs)}` : ''
  return (
    <div ref={root} className={`attachment${generic ? ' file-card' : ''}`} data-testid="attachment">
      {generic && (
        <svg className="file-icon" viewBox="0 0 40 48" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M5 2h20l10 10v34H5V2Z" strokeLinejoin="round" />
          <path d="M25 2v10h10" strokeLinejoin="round" />
          <text x="20" y="32" fill="currentColor" stroke="none" textAnchor="middle" fontSize="8" fontWeight="700">{fileType}</text>
        </svg>
      )}
      {playable && fullUrl ? (
        video ? (
          <video src={fullUrl} controls autoPlay playsInline aria-label={label} style={mediaStyle} />
        ) : (
          <audio src={fullUrl} controls autoPlay aria-label={label} />
        )
      ) : playable ? (
        <button
          type="button"
          className={video && thumbUrl ? 'photo' : 'play'}
          onClick={() => void open()}
          disabled={busy}
          aria-label={`Play ${label}`}
        >
          {video && thumbUrl ? (
            <img src={thumbUrl} alt="" style={mediaStyle} />
          ) : (
            <span>
              ▶ {file.voiceNote ? '🎤 Voice note' : video ? `🎬 ${file.name}` : `🎵 ${file.name}`}
              {duration}
            </span>
          )}
        </button>
      ) : photo ? (
        <button
          type="button"
          className="photo"
          onClick={() => void open()}
          disabled={busy || !!full}
          aria-label={full ? `Photo ${file.name}` : `Show photo ${file.name}`}
        >
          {fullUrl || thumbUrl ? (
            <img src={fullUrl ?? thumbUrl} alt={file.name} style={mediaStyle} data-full={!!fullUrl} />
          ) : (
            <span>Show photo {file.name}</span>
          )}
        </button>
      ) : (
        <span className="file-name" title={file.name}>{generic ? file.name : `📎 ${file.name}`}</span>
      )}
      <span className="small muted">
        {progress !== undefined && (
          <span data-testid="transfer-progress">
            {sending ? 'Uploading' : 'Downloading'} {Math.floor(progress * 100)}% ·{' '}
          </span>
        )}
        {formatSize(file.size)}
        {video && thumbUrl && duration}
        {!generic && !file.voiceNote && (
          <>
            {' · '}
            <button type="button" className="link small" onClick={() => void download()} disabled={busy}>
              {busy ? 'Opening…' : photo || playable ? 'Save' : 'Download'}
            </button>
          </>
        )}
      </span>
      {generic && (
        <button type="button" className="file-download" onClick={() => void download()} disabled={busy || sending}>
          {sending ? 'Sending…' : busy ? 'Opening…' : 'Download'}
        </button>
      )}
      {error && (
        <span className="small error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

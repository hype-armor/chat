// Photos and files in a conversation (ADR-0024). Files are decrypted in the
// core worker; this only shows what it hands back.
import { useEffect, useState } from 'react'
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
  useEffect(() => {
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
  const photo = isPhoto(file.mime)
  const playable = isPlayable(file.mime)
  const video = playable && file.mime.startsWith('video/')
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
    if (full) return full
    setBusy(true)
    setError(undefined)
    try {
      const blob = await core.openAttachment(conversationId, messageId)
      if (photo || playable) setFull(blob)
      return blob
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Photos already on this device show full size (ADR-0025).
  useEffect(() => {
    if (photo && file.downloaded && !full && !busy) void open()
  }, [photo, file.downloaded])

  const download = async () => {
    const blob = await open()
    if (blob) save(blob, file.name)
  }

  const aspect = file.width && file.height ? `${file.width} / ${file.height}` : undefined
  const label = file.voiceNote ? 'Voice note' : file.name
  const duration = file.durationMs ? ` · ${formatDuration(file.durationMs)}` : ''
  return (
    <div className="attachment" data-testid="attachment">
      {playable && fullUrl ? (
        video ? (
          <video src={fullUrl} controls autoPlay playsInline aria-label={label} style={{ aspectRatio: aspect }} />
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
            <img src={thumbUrl} alt="" style={{ aspectRatio: aspect }} />
          ) : (
            <span>
              ▶ {file.voiceNote ? '🎤 Voice note' : video ? `🎬 ${file.name}` : `🎵 ${file.name}`}
              {duration}
            </span>
          )}
        </button>
      ) : photo && (thumbUrl || fullUrl) ? (
        <button
          type="button"
          className="photo"
          onClick={() => void open()}
          disabled={busy || !!full}
          aria-label={full ? `Photo ${file.name}` : `Show photo ${file.name}`}
        >
          <img src={fullUrl ?? thumbUrl} alt={file.name} style={{ aspectRatio: aspect }} data-full={!!fullUrl} />
        </button>
      ) : (
        <span className="file-name">📎 {file.name}</span>
      )}
      <span className="small muted">
        {progress !== undefined && (
          <span data-testid="transfer-progress">
            {sending ? 'Uploading' : 'Downloading'} {Math.floor(progress * 100)}% ·{' '}
          </span>
        )}
        {formatSize(file.size)}
        {video && thumbUrl && duration}
        {!file.voiceNote && (
          <>
            {' · '}
            <button type="button" className="link small" onClick={() => void download()} disabled={busy}>
              {busy ? 'Opening…' : photo || playable ? 'Save' : 'Download'}
            </button>
          </>
        )}
      </span>
      {error && (
        <span className="small error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

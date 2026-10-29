// Voice notes (FR-MED-1): recorded here, then sent like any attachment.
// The microphone is used only while recording.
import { useEffect, useRef, useState } from 'react'
import type { MediaInfo } from '../core/protocol'
import { formatDuration, recorderType } from './media'

/** Longest voice note. */
const MAX_MS = 5 * 60_000

type Recording = { recorder: MediaRecorder; stream: MediaStream; startedAt: number; chunks: Blob[] }

export function Recorder({
  disabled,
  onRecorded,
  onError,
}: {
  disabled: boolean
  onRecorded: (file: File, media: MediaInfo) => void
  onError: (message: string) => void
}) {
  const [elapsed, setElapsed] = useState<number>()
  const recording = useRef<Recording>(undefined)
  const send = useRef(false)

  const stop = (andSend: boolean) => {
    send.current = andSend
    recording.current?.recorder.stop()
  }

  // Leaving the conversation discards a recording in progress.
  useEffect(() => () => stop(false), [])

  useEffect(() => {
    if (elapsed === undefined) return
    const timer = setInterval(() => {
      const r = recording.current
      if (!r) return
      const ms = Date.now() - r.startedAt
      setElapsed(ms)
      if (ms >= MAX_MS) stop(true)
    }, 250)
    return () => clearInterval(timer)
  }, [elapsed === undefined])

  const start = async () => {
    const type = recorderType()
    if (!type || !navigator.mediaDevices?.getUserMedia) return onError("This browser can't record voice notes")
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return onError('Allow the microphone to record a voice note')
    }
    const recorder = new MediaRecorder(stream, { mimeType: type })
    const r: Recording = { recorder, stream, startedAt: Date.now(), chunks: [] }
    recorder.ondataavailable = (e) => e.data.size > 0 && r.chunks.push(e.data)
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop()
      recording.current = undefined
      setElapsed(undefined)
      const durationMs = Date.now() - r.startedAt
      if (!send.current || durationMs < 500) return
      const mime = type.split(';')[0]
      const ext = mime === 'audio/mp4' ? 'm4a' : mime.split('/')[1]
      const file = new File(r.chunks, `voice-note.${ext}`, { type: mime })
      onRecorded(file, { durationMs, voiceNote: true })
    }
    recording.current = r
    recorder.start(1000)
    setElapsed(0)
  }

  if (elapsed === undefined) {
    return (
      <button
        type="button"
        className="secondary"
        onClick={() => void start()}
        disabled={disabled}
        aria-label="Record a voice note"
      >
        🎤
      </button>
    )
  }
  return (
    <span className="recording" role="status" aria-label="Recording a voice note">
      <span className="small">● {formatDuration(elapsed)}</span>
      <button type="button" className="link small" onClick={() => stop(false)}>
        Cancel
      </button>
      <button type="button" onClick={() => stop(true)}>
        Send voice note
      </button>
    </span>
  )
}

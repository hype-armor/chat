// Media helpers for the UI thread, which can decode audio and video (the
// core worker can't): clip duration and a poster frame, and the recorder's
// format.
import type { MediaInfo } from '../core/protocol'

const THUMB_EDGE = 320
const PROBE_TIMEOUT_MS = 10_000

function once(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      el.removeEventListener(event, onEvent)
      el.removeEventListener('error', onError)
      clearTimeout(timer)
      resolve(ok)
    }
    const onEvent = () => done(true)
    const onError = () => done(false)
    const timer = setTimeout(() => done(false), timeoutMs)
    el.addEventListener(event, onEvent)
    el.addEventListener('error', onError)
  })
}

async function posterFrame(video: HTMLVideoElement): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const scale = Math.min(1, THUMB_EDGE / Math.max(video.videoWidth, video.videoHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
  canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.6))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined
}

/** Duration, and for videos the size and a poster frame; undefined if it doesn't decode here. */
export async function probeClip(file: File): Promise<MediaInfo | undefined> {
  const video = file.type.startsWith('video/')
  if (!video && !file.type.startsWith('audio/')) return undefined
  const el = document.createElement(video ? 'video' : 'audio')
  const url = URL.createObjectURL(file)
  try {
    el.preload = 'auto'
    el.muted = true
    if (el instanceof HTMLVideoElement) el.playsInline = true
    const loaded = once(el, 'loadeddata', PROBE_TIMEOUT_MS)
    el.src = url
    if (!(await loaded)) return undefined
    const durationMs = Number.isFinite(el.duration) ? el.duration * 1000 : undefined
    if (!(el instanceof HTMLVideoElement) || !el.videoWidth) return { durationMs }
    // A frame a little in, past any black first frame.
    const seeked = once(el, 'seeked', 3_000)
    el.currentTime = Math.min(0.5, (el.duration || 0) / 2)
    await seeked
    return { durationMs, width: el.videoWidth, height: el.videoHeight, thumbnail: await posterFrame(el) }
  } finally {
    el.removeAttribute('src')
    el.load()
    URL.revokeObjectURL(url)
  }
}

/** A format this browser can record voice in: Opus in WebM or Ogg, else AAC in MP4 (Safari). */
export function recorderType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  )
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

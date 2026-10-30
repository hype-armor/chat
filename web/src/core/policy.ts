// Which attachments download by themselves (FR-MED-6, ADR-0025). Pure, so
// the engine and tests share it.
import type { AutoDownload, MediaSettings } from './protocol'

export const DEFAULT_MEDIA: MediaSettings = {
  photos: 'always',
  audio: 'always',
  video: 'wifi',
  files: 'never',
  quality: 'standard',
}

export type MediaKind = 'photos' | 'audio' | 'video' | 'files'

export function mediaKind(mime: string): MediaKind {
  if (mime.startsWith('image/')) return 'photos'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'files'
}

/**
 * Whether to fetch an attachment as soon as it arrives. "Wi-Fi only" waits
 * whenever the browser says the connection is mobile data or asks to save
 * data; browsers that don't say are treated as not on mobile data.
 */
export function autoDownloads(settings: MediaSettings, mime: string, onMobileData: boolean): boolean {
  const rule: AutoDownload = settings[mediaKind(mime)]
  return rule === 'always' || (rule === 'wifi' && !onMobileData)
}

/** The Network Information API, where the browser has it (Chromium). */
export function onMobileData(): boolean {
  const connection = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection
  return !!connection && (connection.type === 'cellular' || connection.saveData === true)
}

import { describe, expect, it } from 'vitest'
import { DEFAULT_MEDIA, autoDownloads, mediaKind } from './policy'

describe('auto-download policy', () => {
  it('sorts attachments by kind', () => {
    expect(mediaKind('image/jpeg')).toBe('photos')
    expect(mediaKind('audio/webm')).toBe('audio')
    expect(mediaKind('video/mp4')).toBe('video')
    expect(mediaKind('application/pdf')).toBe('files')
  })

  it('follows each kind’s rule and the network', () => {
    expect(autoDownloads(DEFAULT_MEDIA, 'image/png', true)).toBe(true)
    expect(autoDownloads(DEFAULT_MEDIA, 'audio/ogg', true)).toBe(true)
    expect(autoDownloads(DEFAULT_MEDIA, 'video/mp4', false)).toBe(true)
    expect(autoDownloads(DEFAULT_MEDIA, 'video/mp4', true)).toBe(false)
    expect(autoDownloads(DEFAULT_MEDIA, 'application/zip', false)).toBe(false)
    const never = { ...DEFAULT_MEDIA, photos: 'never' as const }
    expect(autoDownloads(never, 'image/png', false)).toBe(false)
  })
})

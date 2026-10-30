// Media settings (FR-MED-5/6, ADR-0025): what downloads by itself, and how
// large photos are sent.
import type { CoreClient } from '../core/client'
import type { AutoDownload, MediaSettings } from '../core/protocol'

const KINDS: { key: 'photos' | 'audio' | 'video' | 'files'; label: string }[] = [
  { key: 'photos', label: 'Photos' },
  { key: 'audio', label: 'Voice notes and audio' },
  { key: 'video', label: 'Videos' },
  { key: 'files', label: 'Other files' },
]

const RULES: { value: AutoDownload; label: string }[] = [
  { value: 'always', label: 'Always' },
  { value: 'wifi', label: 'Not on mobile data' },
  { value: 'never', label: 'When I open them' },
]

export function Media({ core, media }: { core: CoreClient; media: MediaSettings }) {
  const set = (change: Partial<MediaSettings>) => void core.setMedia({ ...media, ...change })
  return (
    <details className="devices">
      <summary>Media</summary>
      <p className="small">Download automatically:</p>
      {KINDS.map(({ key, label }) => (
        <label key={key} className="setting">
          <span>{label}</span>
          <select aria-label={label} value={media[key]} onChange={(e) => set({ [key]: e.target.value as AutoDownload })}>
            {RULES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <p className="muted small">
        Browsers that don't say whether you're on mobile data are treated as not on it.
      </p>
      <label className="setting">
        <span>Send photos at</span>
        <select aria-label="Send photos at" value={media.quality} onChange={(e) => set({ quality: e.target.value as MediaSettings['quality'] })}>
          <option value="standard">Standard quality</option>
          <option value="high">High quality (larger)</option>
        </select>
      </label>
    </details>
  )
}

// A round profile picture, or an initial for people without one, and for
// groups; decorative, so screen readers skip it (the name is always next to it).

import { createContext, useContext, useEffect, useState } from 'react'
import type { CoreClient } from '../core/client'

const COLORS = ['#1f6feb', '#8250df', '#bf3989', '#cf222e', '#bc4c00', '#1a7f37', '#0a7d8c', '#6639ba']

/** The core, so that avatars can read profile pictures. App provides it. */
export const CoreContext = createContext<CoreClient | undefined>(undefined)

function colorOf(key: string): string {
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[hash % COLORS.length]
}

/** An account's profile picture as a data URL; follows changes to it. */
export function useAvatarPhoto(account?: string): string | undefined {
  const core = useContext(CoreContext)
  const [photo, setPhoto] = useState<string>()
  useEffect(() => {
    setPhoto(undefined)
    if (!core || !account) return
    let live = true
    const load = () =>
      core
        .avatar(account)
        .then((base64) => {
          if (live) setPhoto(base64 ? `data:image/jpeg;base64,${base64}` : undefined)
        })
        .catch(() => undefined)
    void load()
    const unsubscribe = core.subscribe((e) => {
      if (e.type === 'avatar' && e.account === account) void load()
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [core, account])
  return photo
}

export function Avatar({
  name,
  id,
  account,
  size = 2.25,
}: {
  name: string
  id: string
  /** The account whose profile picture to show, if any. */
  account?: string
  size?: number
}) {
  const photo = useAvatarPhoto(account)
  if (photo) {
    return (
      <img
        className="avatar"
        src={photo}
        alt=""
        aria-hidden="true"
        style={{ width: `${size}rem`, height: `${size}rem` }}
      />
    )
  }
  const initial = [...(name.trim() || '?')][0].toUpperCase()
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ background: colorOf(id), width: `${size}rem`, height: `${size}rem`, fontSize: `${size * 0.45}rem` }}
    >
      {initial}
    </span>
  )
}

// A round initial for people and groups; decorative, so screen readers
// skip it (the name is always next to it).

const COLORS = ['#1f6feb', '#8250df', '#bf3989', '#cf222e', '#bc4c00', '#1a7f37', '#0a7d8c', '#6639ba']

function colorOf(key: string): string {
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[hash % COLORS.length]
}

export function Avatar({ name, id, size = 2.25 }: { name: string; id: string; size?: number }) {
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

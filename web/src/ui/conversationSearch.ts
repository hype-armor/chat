import type { ConversationSummary } from '../core/protocol'

export function normalizeSearch(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

export function filterConversations(conversations: ConversationSummary[], query: string): ConversationSummary[] {
  const search = normalizeSearch(query.trim())
  return conversations.filter((c) =>
    normalizeSearch(c.title).includes(search) || normalizeSearch(c.peer ?? '').includes(search),
  )
}

export function searchUsername(query: string): string | undefined {
  const username = query.trim().toLowerCase()
  return /^[a-z][a-z0-9_]{2,19}\.[0-9]{2,4}$/.test(username) ? username : undefined
}

export function highlightTitle(title: string, query: string): { text: string; match: boolean }[] {
  const search = normalizeSearch(query.trim())
  if (!search) return [{ text: title, match: false }]
  const normalized = normalizeSearch(title)
  const ranges: { start: number; end: number }[] = []
  for (let start = normalized.indexOf(search); start !== -1; start = normalized.indexOf(search, start + search.length)) {
    ranges.push({ start, end: start + search.length })
  }
  const parts: { text: string; match: boolean }[] = []
  let offset = 0
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title)) {
    const end = offset + normalizeSearch(segment).length
    const match = ranges.some((range) => range.start < end && range.end > offset)
    const last = parts.at(-1)
    if (last?.match === match) last.text += segment
    else parts.push({ text: segment, match })
    offset = end
  }
  return parts
}

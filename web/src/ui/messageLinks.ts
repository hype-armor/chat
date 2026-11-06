export type MessagePart = { text: string; href?: string }

/** Only explicit web URLs become links. Never fetch or parse message HTML. */
export function messageLinks(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  const pattern = /https?:\/\/[^\s<>"\u0000-\u001f]+/gi
  let end = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    let url = match[0].replace(/[.,!?;:]+$/, '')
    while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) url = url.slice(0, -1)
    try {
      const parsed = new URL(url)
      if (!parsed.hostname || parsed.username || parsed.password) continue
      if (start > end) parts.push({ text: text.slice(end, start) })
      parts.push({ text: url, href: url })
      end = start + url.length
    } catch { /* Invalid URLs remain selectable text. */ }
  }
  if (end < text.length) parts.push({ text: text.slice(end) })
  return parts
}

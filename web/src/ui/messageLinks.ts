export type MessagePart = { text: string; href?: string }

/** Only unauthenticated HTTP(S) URLs can become links. */
export function isSafeMessageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !!parsed.hostname && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

/** Only explicit web URLs become links. Never fetch or parse message HTML. */
export function messageLinks(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  const pattern = /https?:\/\/[^\s<>"\u0000-\u001f]+/gi
  let end = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    const candidate = match[0]
    let excessClosing = 0
    for (const character of candidate) {
      if (character === '(') excessClosing--
      else if (character === ')') excessClosing++
    }
    let boundary = candidate.length
    // Keep the existing order: punctuation first, then unmatched closing parentheses.
    while (boundary > 0 && '.,!?;:'.includes(candidate[boundary - 1])) boundary--
    while (boundary > 0 && excessClosing > 0 && candidate[boundary - 1] === ')') {
      boundary--
      excessClosing--
    }
    const url = candidate.slice(0, boundary)
    if (isSafeMessageUrl(url)) {
      if (start > end) parts.push({ text: text.slice(end, start) })
      parts.push({ text: url, href: url })
      end = start + url.length
    }
  }
  if (end < text.length) parts.push({ text: text.slice(end) })
  return parts
}

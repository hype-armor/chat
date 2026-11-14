import type { ReactNode } from 'react'
import { marked, type Token, type Tokens } from 'marked'
import { LinkActions } from './LinkActions'
import { isSafeMessageUrl, messageLinks } from './messageLinks'

function plainText(text: string, key: string, linkify = true): ReactNode[] {
  return text.split(/(\n)/).flatMap((line, index) => {
    if (line === '\n') return [<br key={`${key}-break-${index}`} />]
    if (!linkify) return [line]
    return messageLinks(line).map((part, partIndex) => part.href
      ? <LinkActions key={`${key}-link-${index}-${partIndex}`} text={part.text} href={part.href} />
      : part.text)
  })
}

function childTokens(token: Token): Token[] {
  return (token as { tokens?: Token[] }).tokens ?? []
}

function isExplicitMarkdownLink(token: Tokens.Link): boolean {
  return /^https?:\/\//i.test(token.raw) || /^\[[\s\S]*\]\(\s*<?https?:\/\//i.test(token.raw)
}

function inline(tokens: Token[], key: string): ReactNode[] {
  return tokens.map((token, index) => {
    const tokenKey = `${key}-${index}`
    switch (token.type) {
      case 'text':
        return childTokens(token).length ? inline(childTokens(token), tokenKey) : plainText(token.text, tokenKey)
      case 'strong': return <strong key={tokenKey}>{inline(childTokens(token), tokenKey)}</strong>
      case 'em': return <em key={tokenKey}>{inline(childTokens(token), tokenKey)}</em>
      case 'del': return <del key={tokenKey}>{inline(childTokens(token), tokenKey)}</del>
      case 'codespan': return <code key={tokenKey}>{token.text}</code>
      case 'br': return <br key={tokenKey} />
      case 'link':
        // Markdown links receive the same scheme and credential checks as bare URLs.
        return isExplicitMarkdownLink(token as Tokens.Link) && isSafeMessageUrl(token.href)
          ? <LinkActions
              key={tokenKey}
              text={token.raw.startsWith('[') ? inline(childTokens(token), tokenKey) : token.text}
              href={token.href}
            />
          : plainText(token.raw, tokenKey)
      // Images and HTML could load or inject untrusted content. Show their source instead.
      case 'image':
      case 'html': return plainText(token.raw, tokenKey, false)
      default: return plainText(token.raw, tokenKey)
    }
  })
}

function inlineBlocks(tokens: Token[], key: string): ReactNode[] {
  return tokens.flatMap<ReactNode>((token, index) => token.type === 'paragraph'
    ? inline(childTokens(token), `${key}-${index}`)
    : token.type === 'space' ? plainText(token.raw, `${key}-${index}`, false)
      : [])
}

function blocks(tokens: Token[], key: string): ReactNode[] {
  return tokens.flatMap<ReactNode>((token, index) => {
    const tokenKey = `${key}-${index}`
    switch (token.type) {
      case 'space': return []
      // Reference links are outside the basic Markdown scope, so keep them literal.
      case 'def': return plainText(token.raw, tokenKey, false)
      case 'text': return childTokens(token).length ? inline(childTokens(token), tokenKey) : plainText(token.text, tokenKey)
      case 'paragraph': return [<span key={tokenKey} className="message-paragraph">{inline(childTokens(token), tokenKey)}</span>]
      case 'blockquote': return [<blockquote key={tokenKey}>{blocks(childTokens(token), tokenKey)}</blockquote>]
      case 'list': {
        const list = token as Tokens.List
        const List = list.ordered ? 'ol' : 'ul'
        const start = list.ordered && list.start !== '' ? list.start : undefined
        return [<List key={tokenKey} start={start}>{list.items.map((item: Tokens.ListItem, itemIndex: number) =>
          <li key={`${tokenKey}-${itemIndex}`}>{blocks(item.tokens, `${tokenKey}-${itemIndex}`)}</li>)}</List>]
      }
      case 'code': return [<pre key={tokenKey}><code>{token.text}</code></pre>]
      case 'hr': return [<hr key={tokenKey} />]
      // Basic chat Markdown intentionally does not add headings, tables, or images.
      default: return [<span key={tokenKey}>{plainText(token.raw, tokenKey)}</span>]
    }
  })
}

/** Renders a safe, basic Markdown subset. Raw HTML is always visible text. */
export function MessageText({ text }: { text: string }) {
  const tokens = marked.lexer(text, { breaks: true, gfm: true })
  // Keep plain paragraphs in one text flow. This preserves native selection behavior and blank lines.
  const content = tokens.every((token) => token.type === 'paragraph' || token.type === 'space')
    ? inlineBlocks(tokens, 'message')
    : blocks(tokens, 'message')
  return <div className="text message-text">{content}</div>
}

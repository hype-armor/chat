import { describe, expect, it } from 'vitest'
import { messageLinks } from './messageLinks'

describe('messageLinks', () => {
  it('preserves the complete selectable text', () => {
    const text = 'See (https://example.com/a_(b)), then https://example.org?q=hello!\nDone.'
    const parts = messageLinks(text)
    expect(parts.map((part) => part.text).join('')).toBe(text)
    expect(parts.filter((part) => part.href).map((part) => part.href)).toEqual([
      'https://example.com/a_(b)', 'https://example.org?q=hello',
    ])
  })
  it('accepts HTTP(S), Unicode domains and explicit ports', () => {
    expect(messageLinks('http://example.test:8080 https://例え.jp/道').filter((part) => part.href)).toHaveLength(2)
  })
  it('leaves unsafe schemes, credentials and malformed links as text', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,hi', 'https://', 'https://user:secret@example.test', '<img src=x onerror=alert(1)>']) {
      expect(messageLinks(text).some((part) => part.href)).toBe(false)
      expect(messageLinks(text).map((part) => part.text).join('')).toBe(text)
    }
  })
  it('does not include HTML delimiters in URLs', () => {
    expect(messageLinks('https://example.test/<script>')[0].href).toBe('https://example.test/')
  })
})

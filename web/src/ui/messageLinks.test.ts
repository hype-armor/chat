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
  it('trims tens of thousands of unmatched closing parentheses', () => {
    const url = 'https://example.test/path'
    const suffix = ')'.repeat(50_000) + '.,!?;:'
    const text = `Read ${url}${suffix}`
    const parts = messageLinks(text)
    expect(parts).toEqual([{ text: 'Read ' }, { text: url, href: url }, { text: suffix }])
    expect(parts.map((part) => part.text).join('')).toBe(text)
  })
  it('preserves mixed balanced parentheses before a large unmatched suffix', () => {
    const url = 'https://example.test/' + '(a(b)c)d(e)'.repeat(5_000) + '(tail)'
    const suffix = ')'.repeat(30_000) + '!'
    const parts = messageLinks(url + suffix)
    expect(parts).toEqual([{ text: url, href: url }, { text: suffix }])
    expect(parts.map((part) => part.text).join('')).toBe(url + suffix)
  })
  it('preserves balanced trailing parentheses and the existing punctuation order', () => {
    for (const [text, href, suffix] of [
      ['https://example.test/a_(b).,!?;:', 'https://example.test/a_(b)', '.,!?;:'],
      ['https://example.test/a_(b)).)', 'https://example.test/a_(b)).', ')'],
      ['https://example.test/((a))', 'https://example.test/((a))', ''],
      ['https://example.test/((a)', 'https://example.test/((a)', ''],
      ['https://example.test/)(a)', 'https://example.test/)(a', ')'],
    ]) {
      const parts = messageLinks(text)
      expect(parts.filter((part) => part.href)).toEqual([{ text: href, href }])
      expect(parts.map((part) => part.text).join('')).toBe(text)
      if (suffix) expect(parts.at(-1)).toEqual({ text: suffix })
    }
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

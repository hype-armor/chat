import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageText } from './MessageText'

const render = (text: string) => renderToStaticMarkup(createElement(MessageText, { text }))

describe('MessageText', () => {
  it('renders the supported Markdown formatting', () => {
    const html = render('**bold** and *italic* and ~~old~~ with `code`\n\n> A quote\n\n- first\n- second\n\n```\nconst answer = 42\n```')

    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<del>old</del>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<blockquote><span class="message-paragraph">A quote</span></blockquote>')
    expect(html).toContain('<ul><li>first</li><li>second</li></ul>')
    expect(html).toContain('<pre><code>const answer = 42</code></pre>')
  })

  it('preserves each line break from a sent message', () => {
    expect(render('first line\nsecond line')).toContain('<div class="text message-text">first line<br/>second line</div>')
    expect(render('first line\n\n\nsecond line')).toContain('<div class="text message-text">first line<br/><br/><br/>second line</div>')
  })

  it('uses safe explicit links, preserves formatting in labels, and leaves unsafe links as text', () => {
    const html = render('[**safe** link](https://example.test/path) [unsafe](javascript:alert(1)) [secret](https://user:pass@example.test)')

    expect(html).toContain('<a href="https://example.test/path"')
    expect(html).toContain('<strong>safe</strong> link</a>')
    expect(html).toContain('[unsafe](javascript:alert(1))')
    expect(html).toContain('[secret](https://user:pass@example.test)')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('href="https://user:pass@example.test"')
  })

  it('keeps unsupported automatic and reference links as literal text', () => {
    const html = render('www.example.test\n\n[Safe][reference]\n\n[reference]: https://example.test')

    expect(html).not.toContain('<a ')
    expect(html).toContain('www.example.test')
    expect(html).toContain('[Safe][reference]')
    expect(html).toContain('[reference]: https://example.test')
  })

  it('shows raw HTML and images as text without creating untrusted elements', () => {
    const html = render('<img src=x onerror=alert(1)> and ![remote](https://example.test/image.png)')

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('![remote](https://example.test/image.png)')
    expect(html).not.toContain('<img')
  })
})

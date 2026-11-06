import { useState } from 'react'
import { messageLinks } from './messageLinks'

function MessageLink({ text, href }: { text: string; href: string }) {
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const act = async (share: boolean) => {
    setError('')
    setStatus('')
    try {
      if (share) await navigator.share({ url: href })
      else {
        if (!navigator.clipboard) throw new Error('Clipboard is unavailable. Select the link to copy it.')
        await navigator.clipboard.writeText(href)
        setStatus('Link copied')
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'The action failed')
    }
  }
  return <div className="message-link">
    <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{text}</a>
    <details className="message-link-actions">
      <summary aria-label={`Actions for ${text}`}>Link actions</summary>
      <span className="message-link-buttons">
        <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open</a>
        <button type="button" className="link small" onClick={() => void act(false)}>Copy link</button>
        {typeof navigator.share === 'function' && <button type="button" className="link small" onClick={() => void act(true)}>Share</button>}
      </span>
      <span role="status">{status}</span>
      {error && <span role="alert">{error}</span>}
    </details>
  </div>
}

export function MessageText({ text }: { text: string }) {
  return <div className="text">{messageLinks(text).map((part, index) => part.href
    ? <MessageLink key={index} text={part.text} href={part.href} /> : part.text)}</div>
}

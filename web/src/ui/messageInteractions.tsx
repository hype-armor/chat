import { useEffect, useMemo, useState } from 'react'
import { createTypingSender, trackRemoteTyping } from './typing'
import type { ChatMessage, ReplyPreview as Quote, Typist } from '../core/protocol'
import type { CoreClient } from '../core/client'

export function quoteMessage(message: ChatMessage): Quote {
  return {
    messageId: message.id,
    from: message.from,
    fromName: message.from === 'me' ? 'You' : message.fromName ?? message.from,
    text: (message.text || message.file?.name || (message.location ? 'Location' : message.live ? 'Live location' : 'Message')).slice(0, 280),
  }
}

export function ReplyPreview({ quote, cancel }: { quote: Quote; cancel?: () => void }) {
  return <aside className="reply-preview" aria-label={cancel ? 'Replying to message' : 'Quoted message'}>
    <strong>{quote.fromName ?? (quote.from === 'me' ? 'You' : quote.from ?? 'Message')}</strong>
    <span>{quote.unavailable ? 'Original message unavailable' : quote.text}</span>
    {cancel && <button type="button" className="link small" onClick={cancel}>Cancel reply</button>}
  </aside>
}

/** The worker owns lease expiry and disconnect clearing. */
export function useRemoteTyping(core: CoreClient, id: string, enabled: boolean) {
  const [typists, setTypists] = useState<Typist[]>([])
  useEffect(() => {
    setTypists([])
    if (!enabled) return
    return trackRemoteTyping(core, id, setTypists)
  }, [core, id, enabled])
  return typists.slice(0, 4).map((typist) => typist.name)
}

export function useSendTyping(core: CoreClient, id: string, draft: string, enabled: boolean, focused: boolean) {
  const sender = useMemo(() => createTypingSender(
    (active) => core.setTyping(id, active),
    () => document.visibilityState === 'visible' && document.hasFocus(),
  ), [core, id])
  useEffect(() => { sender.update(draft, enabled, focused) }, [sender, draft, enabled, focused])
  useEffect(() => {
    const hidden = () => { if (document.visibilityState !== 'visible') sender.stop() }
    window.addEventListener('blur', sender.stop)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('blur', sender.stop)
      document.removeEventListener('visibilitychange', hidden)
      sender.stop()
    }
  }, [sender])
}

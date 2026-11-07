import { LinkActions } from './LinkActions'
import { messageLinks } from './messageLinks'

export function MessageText({ text }: { text: string }) {
  return <div className="text">{messageLinks(text).map((part, index) => part.href
    ? <LinkActions key={index} text={part.text} href={part.href} /> : part.text)}</div>
}

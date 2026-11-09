// Synthetic image UI only. No worker transport, network requests, or call media.
import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CoreClient } from '../core/client'
import { Attachment } from '../ui/Attachment'
import '../styles.css'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII='), c => c.charCodeAt(0))
// The same deterministic 2-frame GIF used by the upstream GIF regression fixture.
const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQAHgAAACwAAAAAAQABAAACAkQBACH5BAAeAAAALAAAAAABAAEAAAICTAEAOw=='), c => c.charCodeAt(0))
const pending: { resolve: (blob: Blob) => void; reject: (error: Error) => void }[] = []
let requests = 0
const created: string[] = []
const revoked: string[] = []
const createObjectURL = URL.createObjectURL.bind(URL)
const revokeObjectURL = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (blob) => {
  const url = createObjectURL(blob)
  created.push(url)
  return url
}
URL.revokeObjectURL = (url) => { revoked.push(url); revokeObjectURL(url) }
const core = {
  subscribe: () => () => {},
  openAttachment: () => {
    requests++
    return new Promise<Blob>((resolve, reject) => { pending.push({ resolve, reject }) })
  },
} as unknown as CoreClient

function Fixture() {
  const [mounted, setMounted] = useState(true)
  const [session, setSession] = useState(0)
  // Account changes replace the UI subtree and its client, as Chat does.
  const client = useMemo(() => ({
    subscribe: core.subscribe.bind(core),
    openAttachment: core.openAttachment.bind(core),
  }) as unknown as CoreClient, [session])
  const [call, setCall] = useState<'direct' | 'group'>()
  const params = new URLSearchParams(location.search)
  Object.assign(window, { imageFixture: {
    created, revoked,
    requests: () => requests,
    resolve: (broken = false) => {
      pending.shift()?.resolve(new Blob([broken ? new Uint8Array([1, 2, 3]) : params.get('mime') === 'image/gif' ? gif : png], { type: params.get('mime') ?? 'image/png' }))
    },
    reject: () => { pending.shift()?.reject(new Error('Synthetic image failure')) },
    unmount: () => setMounted(false),
    remountAccount: () => { setSession((value) => value + 1); setMounted(true) },
    incoming: (kind: 'direct' | 'group') => setCall(kind),
  } })
  return <>
    <aside className="sidebar"><button type="button">Background action</button></aside>
    <main>
      {mounted && <Attachment key={session} core={client} conversationId="chat" messageId={params.get('direction') ?? 'received'} file={{
        name: params.get('filename') ?? 'Synthetic image.png', mime: params.get('mime') ?? 'image/png', size: png.length,
        width: 1200, height: 800,
        thumbnail: params.has('thumbnail') ? png : undefined,
        downloaded: params.has('downloaded'),
      }} sending={false} />}
      <button type="button">After image</button>
    </main>
    {call && <div role="dialog" aria-label="Synthetic call" className={call === 'direct' ? 'call-screen' : 'call-prompt'}>
      <button type="button" onClick={() => setCall(undefined)}>Dismiss synthetic call</button>
    </div>}
  </>
}
window.addEventListener('error', (event) => {
  const error = document.createElement('pre')
  error.dataset.testid = 'fixture-error'
  error.textContent = event.message
  document.body.append(error)
})
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('strict') ? <StrictMode><Fixture /></StrictMode> : <Fixture />,
)

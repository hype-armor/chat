// No server transport. Exercise production preparation, crypto and rendering.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { Attachment } from '../ui/Attachment'
import type { CoreClient } from '../core/client'
import '../styles.css'

function Fixture() {
  const [file, setFile] = useState<File>()
  const [blob, setBlob] = useState<Blob>()
  const [result, setResult] = useState('Choose a GIF')
  const [failure, setFailure] = useState(false)
  const core = {
    subscribe: () => () => {},
    openAttachment: async () => {
      if (failure) throw new Error('Fixture download failed')
      if (!blob) throw new Error('No file')
      return blob
    },
  } as unknown as CoreClient
  return <>
    <input aria-label="GIF file" type="file" onChange={(event) => {
      const input = event.target.files?.[0]
      if (!input) return
      setFile(undefined)
      setResult('Preparing')
      const worker = new Worker(new URL('./gif.worker.ts', import.meta.url), { type: 'module' })
      worker.onerror = (error) => { setResult(error.message); worker.terminate() }
      worker.onmessage = ({ data }) => {
        setResult(data.error ?? JSON.stringify({ intact: data.intact, prepared: data.prepared, thumbnail: data.thumbnail > 0 }))
        if (data.blob) { setBlob(data.blob); setFile(input) }
        worker.terminate()
      }
      worker.postMessage(input)
    }} />
    <label><input type="checkbox" checked={failure} onChange={(e) => setFailure(e.target.checked)} />Fail download</label>
    <output>{result}</output>
    {file && <ul className="messages"><li className={new URLSearchParams(location.search).has('mine') ? 'mine' : 'theirs'}>
      <Attachment core={core} conversationId="fixture" messageId="gif" sending={false}
        file={{ name: file.name, mime: file.type, size: file.size, width: 1, height: 1 }} />
    </li></ul>}
  </>
}
window.onerror = (message) => { document.body.dataset.error = String(message) }
createRoot(document.getElementById('root')!).render(<Fixture />)

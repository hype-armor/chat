// The Rust/WASM core runs here, off the UI thread (docs/03-architecture.md §3).
import init, { core_version, GroupBench, self_test } from './pkg/chat_core.js'
import type { CoreResponseBody, RequestEnvelope } from './protocol'

const ready = init()

async function handle({ request }: RequestEnvelope): Promise<CoreResponseBody> {
  await ready
  switch (request.type) {
    case 'status':
      return { type: 'status', status: { version: core_version(), selfTest: self_test() } }
    case 'bench': {
      const t0 = performance.now()
      const bench = new GroupBench(request.members)
      const t1 = performance.now()
      const commitBytes = bench.commitUpdate()
      const t2 = performance.now()
      const members = bench.memberCount()
      bench.free()
      return { type: 'bench', result: { members, setupMs: t1 - t0, commitMs: t2 - t1, commitBytes } }
    }
  }
}

self.onmessage = async (event: MessageEvent<RequestEnvelope>) => {
  const { id } = event.data
  let body: CoreResponseBody
  try {
    body = await handle(event.data)
  } catch (e) {
    body = { type: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  self.postMessage({ id, body })
}

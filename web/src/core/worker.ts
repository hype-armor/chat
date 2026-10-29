// The core worker: hosts the engine (keys, storage, network) off the UI
// thread (docs/03-architecture.md §3).
import { GroupBench, core_version, self_test } from './pkg/chat_core.js'
import { Engine, describeError } from './engine'
import type { CoreEvent, CoreResponseBody, RequestEnvelope } from './protocol'

const engine = new Engine((event: CoreEvent) => self.postMessage({ id: 0, event }))
const started = engine.start()

async function handle({ request }: RequestEnvelope): Promise<CoreResponseBody> {
  await started
  switch (request.type) {
    case 'view':
      return { type: 'view', view: engine.view() }
    case 'requestCode':
      await engine.requestCode(request.phone)
      return { type: 'ok' }
    case 'verify':
      await engine.verify(request.phone, request.code, request.displayName)
      return { type: 'ok' }
    case 'startChat':
      return { type: 'conversation', conversationId: await engine.startChat(request.phone) }
    case 'createGroup':
      return { type: 'conversation', conversationId: await engine.createGroup(request.name, request.phones) }
    case 'addMembers':
      await engine.addMembers(request.conversationId, request.phones)
      return { type: 'ok' }
    case 'members':
      return { type: 'members', members: engine.members(request.conversationId) }
    case 'renameGroup':
      await engine.renameGroup(request.conversationId, request.name)
      return { type: 'ok' }
    case 'makeAdmin':
      await engine.makeAdmin(request.conversationId, request.account)
      return { type: 'ok' }
    case 'removeMember':
      await engine.removeMember(request.conversationId, request.account)
      return { type: 'ok' }
    case 'leaveGroup':
      await engine.leaveGroup(request.conversationId)
      return { type: 'ok' }
    case 'messages':
      return { type: 'messages', messages: await engine.messages(request.conversationId) }
    case 'sendText':
      await engine.sendText(request.conversationId, request.text)
      return { type: 'ok' }
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
    body = { type: 'error', message: describeError(e) }
  }
  self.postMessage({ id, body })
}

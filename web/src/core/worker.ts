// The core worker: hosts the engine (keys, storage, network) off the UI
// thread (docs/03-architecture.md §3).
import { GroupBench, core_version, decodeQr, self_test } from './pkg/chat_core.js'
import { Engine, describeError } from './engine'
import { mapInfo, tile } from './maps'
import type { CoreEvent, CoreResponseBody, MediaEnvelope, RequestEnvelope } from './protocol'
import type { MediaTransformOptions } from './media'

const engine = new Engine((event: CoreEvent) => self.postMessage({ id: 0, event }))
const started = engine.start()

async function handle({ request }: RequestEnvelope): Promise<CoreResponseBody> {
  await started
  switch (request.type) {
    case 'view':
      return { type: 'view', view: engine.view() }
    case 'signUp':
      await engine.signUp(request.username, request.displayName, request.invite)
      return { type: 'ok' }
    case 'createInvite':
      return { type: 'invite', offer: await engine.createInvite() }
    case 'startChat':
      return { type: 'conversation', conversationId: await engine.startChat(request.username) }
    case 'createGroup':
      return { type: 'conversation', conversationId: await engine.createGroup(request.name, request.usernames) }
    case 'addMembers':
      await engine.addMembers(request.conversationId, request.usernames)
      return { type: 'ok' }
    case 'pushKey':
      return { type: 'pushKey', key: await engine.pushKey() }
    case 'enablePush':
      await engine.enablePush(request.subscription)
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
    case 'sendLocation':
      await engine.sendLocation(request.conversationId, request.location)
      return { type: 'ok' }
    case 'startLive':
      await engine.startLive(request.conversationId, request.durationMs, request.location)
      return { type: 'ok' }
    case 'liveUpdate':
      await engine.liveUpdate(request.location)
      return { type: 'ok' }
    case 'stopLive':
      await engine.stopLive(request.conversationId)
      return { type: 'ok' }
    case 'iceServers':
      return { type: 'iceServers', servers: await engine.iceServers() }
    case 'callSignal':
      await engine.callSignal(request.conversationId, request.signal)
      return { type: 'ok' }
    case 'groupCallJoin':
      return { type: 'groupCallJoin', ...(await engine.groupCallJoin(request.conversationId, request.callId)) }
    case 'groupCallStatus':
      return { type: 'groupCallStatus', call: await engine.groupCallStatus(request.conversationId) }
    case 'deviceNames':
      return { type: 'deviceNames', names: engine.deviceNames(request.conversationId) }
    case 'mapInfo':
      return { type: 'mapInfo', info: await mapInfo() }
    case 'tile': {
      const data = await tile(request.z, request.x, request.y)
      return { type: 'tile', data: data as Uint8Array<ArrayBuffer> | undefined }
    }
    case 'sendFile':
      await engine.sendFile(request.conversationId, request.file, request.caption, request.media)
      return { type: 'ok' }
    case 'openAttachment':
      return { type: 'file', blob: await engine.openAttachment(request.conversationId, request.messageId) }
    case 'startLink':
      return { type: 'link', offer: await engine.startLink() }
    case 'cancelLink':
      engine.cancelLink()
      return { type: 'ok' }
    case 'approveLink':
      await engine.approveLink(request.text)
      return { type: 'ok' }
    case 'devices':
      return { type: 'devices', devices: await engine.devices() }
    case 'removeDevice':
      await engine.removeDevice(request.id)
      return { type: 'ok' }
    case 'decodeQr':
      return { type: 'qr', text: decodeQr(request.rgba, request.width, request.height) }
    case 'safetyNumber':
      return { type: 'safety', safety: engine.safetyNumber(request.conversationId, request.account) }
    case 'markVerified':
      await engine.markVerified(request.conversationId, request.account)
      return { type: 'ok' }
    case 'verifyScanned':
      await engine.verifyScanned(request.conversationId, request.account, request.text)
      return { type: 'ok' }
    case 'retryMessage':
      await engine.retryMessage(request.conversationId, request.messageId)
      return { type: 'ok' }
    case 'markRead':
      await engine.markRead(request.conversationId)
      return { type: 'ok' }
    case 'setMedia':
      await engine.setMedia(request.media)
      return { type: 'ok' }
    case 'setReadReceipts':
      await engine.setReadReceipts(request.on)
      return { type: 'ok' }
    case 'setRelayCalls':
      await engine.setRelayCalls(request.on)
      return { type: 'ok' }
    case 'setupBackup':
      return { type: 'recoveryKey', key: await engine.setupBackup() }
    case 'backupNow':
      await engine.backupNow()
      return { type: 'ok' }
    case 'turnOffBackup':
      await engine.turnOffBackup()
      return { type: 'ok' }
    case 'restore':
      await engine.restore(request.username, request.recoveryKey)
      return { type: 'ok' }
    case 'deleteAccount':
      await engine.deleteAccount(request.username)
      return { type: 'ok' }
    case 'acceptRequest':
      await engine.acceptRequest(request.conversationId)
      return { type: 'ok' }
    case 'block':
      await engine.block(request.account)
      return { type: 'ok' }
    case 'unblock':
      await engine.unblock(request.account)
      return { type: 'ok' }
    case 'blocked':
      return { type: 'blocked', contacts: engine.blockedContacts() }
    case 'report':
      await engine.report(request.conversationId, request.account, request.reason, request.includeMessages)
      return { type: 'ok' }
    case 'dismissAlert':
      await engine.dismissAlert(request.id)
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

// Call media (ADR-0030): RTCRtpScriptTransform hands encoded frames here.
self.addEventListener('rtctransform', (event) => {
  const { transformer } = event as unknown as {
    transformer: { readable: ReadableStream; writable: WritableStream; options: MediaTransformOptions }
  }
  void started
    .then(() => engine.attachMedia(transformer.readable, transformer.writable, transformer.options))
    .catch((e) => console.warn('call media transform failed', e))
})

self.onmessage = async (event: MessageEvent<RequestEnvelope | MediaEnvelope>) => {
  if ('media' in event.data) {
    // Chromium's encoded streams, transferred from the page.
    const { readable, writable, media } = event.data
    void started.then(() => engine.attachMedia(readable, writable, media))
    return
  }
  const { id } = event.data
  let body: CoreResponseBody
  try {
    body = await handle(event.data)
  } catch (e) {
    body = { type: 'error', message: describeError(e) }
  }
  self.postMessage({ id, body })
}

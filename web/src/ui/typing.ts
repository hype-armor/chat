import type { CoreClient } from '../core/client'
import type { Typist } from '../core/protocol'

/** Subscribe first. A newer event must win over the initial snapshot. */
export function trackRemoteTyping(core: Pick<CoreClient, 'typing' | 'subscribe'>, id: string, update: (typists: Typist[]) => void) {
  let live = true
  let receivedEvent = false
  const unsubscribe = core.subscribe((event) => {
    if (event.type !== 'typing' || event.conversationId !== id) return
    receivedEvent = true
    if (live) update(event.typists)
  })
  void core.typing(id).then((typists) => {
    if (live && !receivedEvent) update(typists)
  }).catch(() => undefined)
  return () => { live = false; unsubscribe() }
}

/** Only a new edit can start typing. Focus and visibility changes can only stop it. */
export function createTypingSender(send: (active: boolean) => Promise<void>, canSend: () => boolean) {
  let draft = ''
  let active = false
  let lastSent = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const emit = (value: boolean) => { void send(value).catch(() => undefined) }
  const stop = () => {
    clearTimeout(timer)
    if (active) emit(false)
    active = false
    lastSent = 0
  }
  return {
    stop,
    update(next: string, enabled: boolean, focused: boolean) {
      const edited = next !== draft
      draft = next
      if (!enabled || !focused || !next.trim() || !canSend()) { stop(); return }
      if (!edited) return
      if (!active || Date.now() - lastSent >= 2000) {
        emit(true)
        active = true
        lastSent = Date.now()
      }
      clearTimeout(timer)
      timer = setTimeout(stop, 4000)
    },
  }
}

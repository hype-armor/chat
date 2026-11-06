import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreClient } from '../core/client'
import type { CoreEvent, Typist } from '../core/protocol'
import { createTypingSender, trackRemoteTyping } from './typing'

afterEach(() => vi.useRealTimers())

describe('typing sender', () => {
  it('throttles edits, stops after idle, and restarts only on another edit', () => {
    vi.useFakeTimers()
    const send = vi.fn(async (_active: boolean) => {})
    const sender = createTypingSender(send, () => true)
    sender.update('h', true, true)
    sender.update('hi', true, true)
    expect(send.mock.calls).toEqual([[true]])
    vi.advanceTimersByTime(2000)
    sender.update('hi!', true, true)
    expect(send.mock.calls).toEqual([[true], [true]])
    vi.advanceTimersByTime(4000)
    expect(send.mock.calls.at(-1)).toEqual([false])
    sender.update('hi!', true, true)
    expect(send).toHaveBeenCalledTimes(3)
    sender.update('hi!!', true, true)
    expect(send.mock.calls.at(-1)).toEqual([true])
    sender.stop()
  })
  it('stops on blur, disable, and hidden state without restarting a background draft', () => {
    vi.useFakeTimers()
    let visible = true
    const send = vi.fn(async (_active: boolean) => {})
    const sender = createTypingSender(send, () => visible)
    sender.update('hello', true, true)
    sender.update('hello', true, false)
    sender.update('hello', true, true)
    expect(send.mock.calls).toEqual([[true], [false]])
    sender.update('hello!', true, true)
    visible = false
    sender.stop()
    sender.update('background edit', true, true)
    visible = true
    sender.update('background edit', true, true)
    expect(send.mock.calls).toEqual([[true], [false], [true], [false]])
    sender.update('new edit', true, true)
    sender.update('new edit', false, true)
    expect(send.mock.calls.at(-1)).toEqual([false])
    vi.advanceTimersByTime(10000)
    expect(send).toHaveBeenCalledTimes(6)
  })
})

describe('remote typing', () => {
  it('keeps a newer event instead of a stale snapshot and does not expire names in the UI', async () => {
    vi.useFakeTimers()
    let listener: (event: CoreEvent) => void = () => {}
    let resolve: (value: Typist[]) => void = () => {}
    const unsubscribe = vi.fn()
    const core = {
      subscribe: (next: typeof listener) => { listener = next; return unsubscribe },
      typing: () => new Promise<Typist[]>((done) => { resolve = done }),
    } as Pick<CoreClient, 'typing' | 'subscribe'>
    const update = vi.fn()
    const dispose = trackRemoteTyping(core, 'chat', update)
    listener({ type: 'typing', conversationId: 'chat', typists: [{ account: 'a', name: 'Alice' }] })
    resolve([])
    await Promise.resolve()
    vi.advanceTimersByTime(9000)
    expect(update.mock.calls).toEqual([[[{ account: 'a', name: 'Alice' }]]])
    listener({ type: 'typing', conversationId: 'chat', typists: [] })
    expect(update.mock.calls.at(-1)).toEqual([[]])
    dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('ignores a snapshot after cleanup', async () => {
    let resolve: (value: Typist[]) => void = () => {}
    const update = vi.fn()
    const dispose = trackRemoteTyping({ subscribe: () => () => {}, typing: () => new Promise((done) => { resolve = done }) }, 'chat', update)
    dispose()
    resolve([{ account: 'a', name: 'Alice' }])
    await Promise.resolve()
    expect(update).not.toHaveBeenCalled()
  })
})

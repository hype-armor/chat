import { describe, expect, it, vi } from 'vitest'
import { PresenceClient, type PresenceClientDependencies, type PresenceGrant } from './presenceClient'

const now = 100_000
const envelope = { device: 'phone', generation: '1', ciphertext: 'sealed' }
const event = { account: 'alice', device: 'phone', generation: '1', state: 'online' as const,
  sentAt: now, expiresAt: now + 5_000 }
const grant: PresenceGrant = { sender: 'alice', recipient: 'bob', recipientDevice: 'bob-device', generation: '1' }

function setup() {
  const deps: PresenceClientDependencies<string> = {
    poll: vi.fn(async () => [envelope]),
    authenticate: vi.fn(async () => event),
    currentGrant: vi.fn(async () => grant),
    isCurrent: () => true,
    allowed: () => true,
    now: () => now,
  }
  return { deps, client: new PresenceClient('alice', 'bob', 'bob-device', deps) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('experimental presence client', () => {
  it('independently reads the current grant after polling and authenticating', async () => {
    const { client, deps } = setup()
    const order: string[] = []
    deps.poll = async () => { order.push('poll'); return [envelope] }
    deps.authenticate = async () => { order.push('authenticate'); return event }
    deps.currentGrant = async () => { order.push('grant'); return grant }
    expect(await client.refresh()).toBe('online')
    expect(order).toEqual(['poll', 'authenticate', 'grant'])
  })

  it('rejects delayed old-generation bytes, revoked grants and bad bindings', async () => {
    const { client, deps } = setup()
    deps.currentGrant = async () => ({ ...grant, generation: '2' })
    expect(await client.refresh()).toBe('unknown')
    deps.currentGrant = async () => ({ ...grant, generation: null })
    expect(await client.refresh()).toBe('unknown')
    deps.currentGrant = async () => ({ ...grant, recipient: 'other' })
    expect(await client.refresh()).toBe('unknown')
    deps.currentGrant = async () => ({ ...grant, generation: '3' })
    deps.authenticate = async () => ({ ...event, generation: '3', device: 'other' })
    expect(await client.refresh()).toBe('unknown')
  })

  it('does not publish a delayed or invalidated refresh', async () => {
    const { client, deps } = setup()
    const pending = deferred<readonly typeof envelope[]>()
    deps.poll = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([envelope])
    const first = client.refresh()
    expect(await client.refresh()).toBe('online')
    pending.resolve([envelope])
    expect(await first).toBeUndefined()
    const second = deferred<readonly typeof envelope[]>()
    deps.poll = () => second.promise
    const waiting = client.refresh()
    client.invalidate()
    second.resolve([envelope])
    expect(await waiting).toBeUndefined()
  })

  it('fails closed on network errors and lifecycle changes', async () => {
    const { client, deps } = setup()
    deps.currentGrant = async () => { throw new Error('network') }
    expect(await client.refresh()).toBe('unknown')
    let current = true
    deps.isCurrent = () => current
    deps.poll = async () => { current = false; return [envelope] }
    expect(await client.refresh()).toBe('unknown')
  })
})

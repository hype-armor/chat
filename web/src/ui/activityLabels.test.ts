import { describe, expect, it } from 'vitest'
import { typingLabel } from './messageInteractions'

describe('activity labels', () => {
  it('keeps generic typing and renders activity as plain text', () => {
    expect(typingLabel([{ account: 'a', name: 'Alice' }])).toBe('Alice is typing…')
    expect(typingLabel([{ account: 'a', name: 'Alice', activity: 'thinking' }])).toBe('Alice is thinking…')
    expect(typingLabel([{ account: 'a', name: 'Alice', activity: 'working' }])).toBe('Alice is working…')
    expect(typingLabel([{ account: 'a', name: 'Alice', activity: 'using', tool: 'read_file' }])).toBe('Alice is using read_file…')
    expect(typingLabel([{ account: 'a', name: 'Alice', activity: 'using', tool: '<script>' }])).toBe('Alice is typing…')
    expect(typingLabel([{ account: 'a', name: 'Alice' }, { account: 'b', name: 'Bob' }])).toBe('Alice, Bob are typing…')
  })
})

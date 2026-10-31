import { describe, expect, it } from 'vitest'
import type { ConversationSummary } from '../core/protocol'
import { filterConversations, highlightTitle, normalizeSearch, searchUsername } from './conversationSearch'

const conversations: ConversationSummary[] = [
  { id: 'group', title: 'Café Équipe', isGroup: true, request: false },
  { id: 'peer', title: 'Other name', peer: 'alice.42', request: false },
  { id: 'request', title: 'Zoë', peer: 'zoe.12', request: true },
].map((c) => ({ isGroup: false, amAdmin: false, status: 'active', memberCount: 2, unread: 0, lastAt: 0, ...c }))

describe('conversation search', () => {
  it('ignores case and composed or decomposed accents', () => {
    expect(normalizeSearch('CAFÉ E\u0301quipe')).toBe('cafe equipe')
    expect(filterConversations(conversations, ' CAFE e\u0301Q ')).toEqual([conversations[0]])
  })

  it('matches peer usernames independently of titles and includes requests', () => {
    expect(filterConversations(conversations, 'ALICE.4')).toEqual([conversations[1]])
    expect(filterConversations(conversations, 'ZOE')).toEqual([conversations[2]])
  })

  it('restores all conversations on clearing and handles empty lists and no matches', () => {
    expect(filterConversations(conversations, '')).toEqual(conversations)
    expect(filterConversations(conversations, '  ')).toEqual(conversations)
    expect(filterConversations(conversations, 'missing')).toEqual([])
    expect(filterConversations([], 'cafe')).toEqual([])
  })

  it('does not search message previews or mutate the summaries', () => {
    const summary = { ...conversations[0], lastText: 'secret' }
    expect(filterConversations([summary], 'secret')).toEqual([])
    expect(filterConversations([summary], 'cafe')[0]).toBe(summary)
  })
})

describe('title highlighting', () => {
  it('preserves original accents, combining marks, emoji and repeated matches', () => {
    expect(highlightTitle('☕ Café / Cafe\u0301!', 'CAFE')).toEqual([
      { text: '☕ ', match: false },
      { text: 'Café', match: true },
      { text: ' / ', match: false },
      { text: 'Cafe\u0301', match: true },
      { text: '!', match: false },
    ])
    expect(highlightTitle('😊 Zoë', 'zo')).toEqual([
      { text: '😊 ', match: false }, { text: 'Zo', match: true }, { text: 'ë', match: false },
    ])
  })

  it('treats punctuation and markup as literal text', () => {
    expect(highlightTitle('<a>.*</a>', '.*')).toEqual([
      { text: '<a>', match: false }, { text: '.*', match: true }, { text: '</a>', match: false },
    ])
    expect(highlightTitle('Café', '')).toEqual([{ text: 'Café', match: false }])
    expect(highlightTitle('Café', 'missing')).toEqual([{ text: 'Café', match: false }])
  })
})

describe('search username shortcut', () => {
  it('only offers complete usernames accepted by registration', () => {
    expect(searchUsername(' Alice_1.0042 ')).toBe('alice_1.0042')
    for (const query of ['alice', 'al.42', '1alice.42', 'alice.4', 'alice.12345', 'álîce.42', 'a'.repeat(21) + '.42']) {
      expect(searchUsername(query)).toBeUndefined()
    }
  })
})

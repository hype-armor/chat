import { describe, expect, it } from 'vitest'
import { suggestUsername } from './Onboarding'

describe('suggestUsername', () => {
  it('turns a display name into name.NN', () => {
    expect(suggestUsername('Alex Smith')).toMatch(/^alexsmith\.\d{2}$/)
    expect(suggestUsername('Zoë')).toMatch(/^zoe\.\d{2}$/)
    expect(suggestUsername('42 Ann')).toMatch(/^ann\.\d{2}$/)
  })
  it('suggests nothing when too little is left', () => {
    expect(suggestUsername('Al')).toBe('')
    expect(suggestUsername('李')).toBe('')
  })
})

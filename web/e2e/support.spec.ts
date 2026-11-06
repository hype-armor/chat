import { expect, test } from '@playwright/test'
import { randomUsername } from './support'

test('test usernames keep their format without insecure randomness', () => {
  const insecureRandom = Math.random
  try {
    Math.random = () => { throw new Error('Test usernames must not use Math.random') }
    for (let i = 0; i < 100; i++) expect(randomUsername()).toMatch(/^u\d{7}\.\d{2}$/)
  } finally {
    Math.random = insecureRandom
  }
})
